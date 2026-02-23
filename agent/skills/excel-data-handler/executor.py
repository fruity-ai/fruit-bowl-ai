#!/usr/bin/env python3
import csv
import contextlib
import io
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

import pandas as pd
from pydantic import BaseModel, ConfigDict, Field, ValidationError

ALLOWED_EXT = {".csv", ".xlsx", ".xls", ".parquet"}
ALLOWED_OPS = {
    "preview",
    "columns",
    "describe",
    "filter_eq",
    "filter_contains",
    "search_text_any_column",
    "groupby_sum",
    "value_counts",
    "python_code",
}


class DataAction(BaseModel):
    model_config = ConfigDict(extra="allow")
    file: Optional[str] = None
    operation: Literal[
        "preview",
        "columns",
        "describe",
        "filter_eq",
        "filter_contains",
        "search_text_any_column",
        "groupby_sum",
        "value_counts",
        "python_code",
    ] = "preview"
    args: Dict[str, Any] = Field(default_factory=dict)


def out(payload: Dict[str, Any], code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, default=str))
    raise SystemExit(code)


def safe_resolve(root: Path, rel_path: str) -> Path:
    candidate = (root / rel_path).resolve()
    root_resolved = root.resolve()
    if candidate == root_resolved or str(candidate).startswith(str(root_resolved) + os.sep):
        return candidate
    raise ValueError("path escapes DATAFILES_ROOT")


def _read_csv_with_recovery(file_path: Path) -> tuple[pd.DataFrame, Dict[str, str]]:
    encodings = ["utf-8", "utf-8-sig", "cp1252", "latin-1"]
    last_err = None

    for enc in encodings:
        try:
            # Attempt delimiter sniffing from a small sample.
            with open(file_path, "r", encoding=enc, errors="strict", newline="") as fh:
                sample = fh.read(4096)
            delimiter = ","
            try:
                dialect = csv.Sniffer().sniff(sample, delimiters=[",", ";", "\t", "|"])
                delimiter = dialect.delimiter
            except Exception:
                delimiter = ","

            df = pd.read_csv(file_path, encoding=enc, sep=delimiter)
            return df, {"encoding": enc, "delimiter": delimiter}
        except Exception as e:
            last_err = e
            continue

    raise ValueError(f"failed to read CSV with common encodings: {last_err}")


def load_df(file_path: Path) -> tuple[pd.DataFrame, Dict[str, str]]:
    ext = file_path.suffix.lower()
    if ext == ".csv":
        return _read_csv_with_recovery(file_path)
    if ext in {".xlsx", ".xls"}:
        try:
            return pd.read_excel(file_path), {"engine": "auto"}
        except Exception:
            # Some xlsx files require openpyxl explicitly.
            return pd.read_excel(file_path, engine="openpyxl"), {"engine": "openpyxl"}
    if ext == ".parquet":
        return pd.read_parquet(file_path), {"engine": "parquet"}
    raise ValueError(f"unsupported file type: {ext}")


def discover_files(root: Path) -> List[Path]:
    files: List[Path] = []
    for p in root.rglob("*"):
        if p.is_file() and p.suffix.lower() in ALLOWED_EXT:
            files.append(p)
    files.sort(key=lambda x: str(x))
    return files


def build_catalog(root: Path, max_files: int = 30) -> List[Dict[str, Any]]:
    files = discover_files(root)[:max_files]
    catalog = []
    for file_path in files:
        rel = str(file_path.relative_to(root))
        try:
            df, read_meta = load_df(file_path)
            sample = df.head(3).to_dict(orient="records")
            columns = [str(c) for c in list(df.columns)]
            rows = int(len(df))
            catalog.append(
                {
                    "file": rel,
                    "columns": columns[:50],
                    "rows": rows,
                    "sample": sample,
                    "read_meta": read_meta,
                }
            )
        except Exception as e:
            catalog.append({"file": rel, "error": str(e)})
    return catalog


def choose_file(root: Path, action: Dict[str, Any], message: str) -> Path:
    requested = (action.get("file") or "").strip()
    if requested:
        target = safe_resolve(root, requested)
        if not target.exists() or not target.is_file():
            raise ValueError(f"file not found: {requested}")
        return target

    files = discover_files(root)
    if not files:
        raise ValueError("no data files found in DATAFILES_ROOT")

    haystack = message.lower()
    best = files[0]
    best_score = -1
    for f in files:
        score = 0
        rel = str(f.relative_to(root)).lower()
        name = f.stem.lower()
        if rel in haystack:
            score += 10
        if name in haystack:
            score += 6
        for token in name.replace("-", "_").split("_"):
            if token and token in haystack:
                score += 1
        if score > best_score:
            best = f
            best_score = score
    return best


def render_df(df: pd.DataFrame, rows: int = 20) -> str:
    if df.empty:
        return "(no rows)"
    show = df.head(rows)
    return show.to_string(index=False)


def write_df(file_path: Path, df: pd.DataFrame) -> Dict[str, str]:
    ext = file_path.suffix.lower()
    if ext == ".csv":
        df.to_csv(file_path, index=False)
        return {"engine": "csv"}
    if ext in {".xlsx", ".xls"}:
        df.to_excel(file_path, index=False)
        return {"engine": "excel"}
    if ext == ".parquet":
        df.to_parquet(file_path, index=False)
        return {"engine": "parquet"}
    raise ValueError(f"unsupported output file type: {ext}")


def execute_python_code(root: Path, code: str, file_hint: Optional[str], limit: int) -> Dict[str, Any]:
    selected_file = ""
    loaded_df: Optional[pd.DataFrame] = None
    read_meta: Dict[str, str] = {}

    if file_hint:
        target = safe_resolve(root, file_hint)
        if not target.exists() or not target.is_file():
            raise ValueError(f"file not found: {file_hint}")
        loaded_df, read_meta = load_df(target)
        selected_file = str(target.relative_to(root))

    def discover_rel_files() -> List[str]:
        return [str(p.relative_to(root)) for p in discover_files(root)]

    def read_table(rel_path: str) -> pd.DataFrame:
        target = safe_resolve(root, rel_path)
        if not target.exists() or not target.is_file():
            raise ValueError(f"file not found: {rel_path}")
        df, _meta = load_df(target)
        return df

    def write_table(df: pd.DataFrame, rel_path: str) -> Dict[str, str]:
        if not isinstance(df, pd.DataFrame):
            raise ValueError("write_table requires a pandas DataFrame")
        target = safe_resolve(root, rel_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        return write_df(target, df)

    safe_builtins = {
        "len": len,
        "min": min,
        "max": max,
        "sum": sum,
        "sorted": sorted,
        "range": range,
        "enumerate": enumerate,
        "list": list,
        "dict": dict,
        "set": set,
        "tuple": tuple,
        "str": str,
        "int": int,
        "float": float,
        "bool": bool,
        "abs": abs,
        "round": round,
        "any": any,
        "all": all,
        "print": print,
        "locals": locals,
    }

    stdout = io.StringIO()
    local_env: Dict[str, Any] = {
        "pd": pd,
        "data_root": str(root),
        "discover_files": discover_rel_files,
        "read_table": read_table,
        "write_table": write_table,
        "result": None,
    }
    if loaded_df is not None:
        local_env["df"] = loaded_df.copy()
        local_env["selected_file"] = selected_file

    with contextlib.redirect_stdout(stdout):
        exec(code, {"__builtins__": safe_builtins}, local_env)

    result_obj = local_env.get("result")
    printed = stdout.getvalue().strip()

    result_rows = None
    body = ""
    if isinstance(result_obj, pd.DataFrame):
        result_rows = int(len(result_obj))
        body = render_df(result_obj, max(1, min(200, limit)))
    elif isinstance(result_obj, pd.Series):
        series_df = result_obj.reset_index()
        result_rows = int(len(series_df))
        body = render_df(series_df, max(1, min(200, limit)))
    elif result_obj is not None:
        body = str(result_obj)
    elif printed:
        body = printed
    else:
        body = "Code executed. Set variable `result` to return a value."

    return {
        "selected_file": selected_file or "(dynamic)",
        "rows": int(len(loaded_df)) if loaded_df is not None else None,
        "result_rows": result_rows,
        "result": body,
        "read_meta": read_meta if read_meta else None,
    }


def run_action(root: Path, action: Dict[str, Any], message: str) -> Dict[str, Any]:
    try:
        parsed_action = DataAction.model_validate(action)
    except ValidationError as e:
        raise ValueError(f"invalid action schema: {e}") from e

    action_dict = parsed_action.model_dump()
    op = (parsed_action.operation or "preview").strip().lower()
    args = parsed_action.args if isinstance(parsed_action.args, dict) else {}

    if op not in ALLOWED_OPS:
        raise ValueError(f"unsupported operation: {op}")
    if op == "python_code":
        code = str(args.get("code", "") or args.get("script", "")).strip()
        if not code:
            raise ValueError("python_code requires args.code")
        limit = int(args.get("limit", 50) or 50)
        py_out = execute_python_code(root, code, parsed_action.file, limit)
        return {
            "ok": True,
            "selected_file": py_out["selected_file"],
            "operation": op,
            "rows": py_out["rows"],
            "result_rows": py_out["result_rows"],
            "result": py_out["result"],
            "read_meta": py_out["read_meta"],
        }

    target = choose_file(root, action_dict, message)
    df, read_meta = load_df(target)
    result_row_count = int(len(df))

    if op == "preview":
        n = int(args.get("rows", 10) or 10)
        n = max(1, min(100, n))
        shown = df.head(n)
        result_row_count = int(len(shown))
        body = render_df(shown, n)
    elif op == "columns":
        body = "\n".join([str(c) for c in df.columns])
        result_row_count = int(len(df.columns))
    elif op == "describe":
        described = df.describe(include="all").fillna("")
        result_row_count = int(len(described))
        body = described.to_string()
    elif op == "filter_eq":
        column = str(args.get("column", "")).strip()
        value = args.get("value")
        limit = int(args.get("limit", 20) or 20)
        if not column:
            raise ValueError("filter_eq requires args.column")
        if column not in df.columns:
            raise ValueError(f"column not found: {column}")
        filtered = df[df[column].astype(str) == str(value)]
        result_row_count = int(len(filtered))
        body = render_df(filtered, limit)
    elif op == "filter_contains":
        column = str(args.get("column", "")).strip()
        value = str(args.get("value", "")).strip()
        limit = int(args.get("limit", 20) or 20)
        case_sensitive = bool(args.get("case_sensitive", False))
        if not column or not value:
            raise ValueError("filter_contains requires args.column and args.value")
        if column not in df.columns:
            raise ValueError(f"column not found: {column}")
        series = df[column].astype(str)
        contains_mask = series.str.contains(value, case=case_sensitive, na=False, regex=False)
        filtered = df[contains_mask]
        result_row_count = int(len(filtered))
        body = render_df(filtered, limit)
    elif op == "search_text_any_column":
        value = str(args.get("value", "")).strip()
        limit = int(args.get("limit", 20) or 20)
        case_sensitive = bool(args.get("case_sensitive", False))
        columns_arg = args.get("columns")
        if not value:
            raise ValueError("search_text_any_column requires args.value")

        if isinstance(columns_arg, list) and columns_arg:
            target_cols = [str(c) for c in columns_arg if str(c) in df.columns]
            if not target_cols:
                raise ValueError("search_text_any_column columns not found")
        else:
            # Search all object-like columns by default.
            target_cols = [str(c) for c in df.columns if df[c].dtype == "object"] or [str(c) for c in df.columns]

        mask = None
        for col in target_cols:
            col_mask = df[col].astype(str).str.contains(value, case=case_sensitive, na=False, regex=False)
            mask = col_mask if mask is None else (mask | col_mask)
        filtered = df[mask] if mask is not None else df.iloc[0:0]
        result_row_count = int(len(filtered))
        body = render_df(filtered, limit)
    elif op == "groupby_sum":
        group_by = str(args.get("group_by", "")).strip()
        value_col = str(args.get("value_col", "")).strip()
        if not group_by or not value_col:
            raise ValueError("groupby_sum requires args.group_by and args.value_col")
        if group_by not in df.columns or value_col not in df.columns:
            raise ValueError("groupby_sum columns not found")
        grouped = (
            df.groupby(group_by, dropna=False)[value_col]
            .sum(numeric_only=False)
            .reset_index()
            .sort_values(value_col, ascending=False)
        )
        result_row_count = int(len(grouped))
        body = render_df(grouped, 50)
    elif op == "value_counts":
        column = str(args.get("column", "")).strip()
        if not column:
            raise ValueError("value_counts requires args.column")
        if column not in df.columns:
            raise ValueError(f"column not found: {column}")
        top_n = int(args.get("top_n", 20) or 20)
        vc = df[column].value_counts(dropna=False).head(top_n).reset_index()
        vc.columns = [column, "count"]
        result_row_count = int(len(vc))
        body = render_df(vc, top_n)
    rel = str(target.relative_to(root))
    return {
        "ok": True,
        "selected_file": rel,
        "operation": op,
        "rows": int(len(df)),
        "result_rows": result_row_count,
        "result": body,
        "read_meta": read_meta,
    }


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        out({"ok": False, "error": "missing input json"}, 1)

    payload = json.loads(raw)
    root_raw = payload.get("skill_root")
    if not isinstance(root_raw, str) or not root_raw.strip():
        root_raw = payload.get("data_root")
    if not isinstance(root_raw, str) or not root_raw.strip():
        out({"ok": False, "error": "skill_root (or data_root) is required"}, 1)

    root = Path(root_raw).resolve()
    if not root.exists():
        root.mkdir(parents=True, exist_ok=True)

    mode = str(payload.get("mode", "execute")).strip().lower()

    try:
        if mode == "catalog":
            out({"ok": True, "catalog": build_catalog(root)})
        action = payload.get("action") if isinstance(payload.get("action"), dict) else {}
        message = str(payload.get("message", ""))
        out(run_action(root, action, message))
    except Exception as e:
        out({"ok": False, "error": str(e)}, 1)


if __name__ == "__main__":
    main()
