# Skill: Excel Data Handler

## Goal
Handle user data questions against local CSV/Excel/Parquet files using pandas.
Runtime executor: `agent/skills/excel-data-handler/executor.py`.

## Workflow
1. Build a catalog of files from the data skill root (`MEMORY_ROOT/data` by default).
2. Use file names + columns + sample rows to identify target data.
3. Perform one of:
- preview
- columns
- describe
- filter_eq
- filter_contains
- search_text_any_column
- groupby_sum
- value_counts
- python_code
4. Return human-readable result.

## Rules
- Always resolve target file inside the configured data root.
- If unsure, return a preview before destructive assumptions.
- Prefer deterministic operations and include selected file path in answer.

## Output style
- One-paragraph summary.
- Then compact table-like lines if needed.

## Advanced mode: `python_code`
For complex requests, run custom pandas logic with:
- `action.operation = "python_code"`
- `action.args.code = "<python script>"`

Available helpers inside script:
- `discover_files()` -> list of relative data files
- `read_table(rel_path)` -> DataFrame
- `write_table(df, rel_path)` -> write DataFrame to CSV/XLSX/XLS/Parquet in data root
- `pd` -> pandas
- `df` -> preloaded DataFrame if `action.file` is set
- `result` -> assign final output object/string/DataFrame for return
