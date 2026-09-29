export default function (pi: any) {
  pi.on("before_agent_start", async (event: any) => {
    const skills = event.systemPromptOptions?.skills;
    console.error(`[probe] skills: ${Array.isArray(skills) ? skills.length : typeof skills}`);
    if (Array.isArray(skills) && skills.length > 1) {
      const removed = skills.splice(1); // keep only the first skill
      console.error(`[probe] removed ${removed.length}: ${removed.map((s: any) => s?.name).join(", ")}`);
    }
    return {};
  });
}
