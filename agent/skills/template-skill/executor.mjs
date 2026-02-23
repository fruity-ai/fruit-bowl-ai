export async function getContext(payload) {
  return {
    ok: true,
    context_type: "template",
    data_root: payload?.data_root || "",
    note: "Replace with lightweight discovery context for your skill.",
  };
}

export async function execute(payload) {
  const action = payload?.action && typeof payload.action === "object" ? payload.action : {};
  return {
    ok: true,
    skill: "template-skill",
    action,
    summary: "Template skill executed. Replace this executor with real logic.",
  };
}
