export const TOOL_NAME_ALIASES: Record<string, string> = {
  Glob: "glob",
  Grep: "grep",
  WebSearch: "web_search",
  WebFetch: "web_fetch",
  CreateImage: "create_image",
  Question: "question",
  ToDoList: "todo_list",
  TodoList: "todo_list",
  LoadMcpTool: "load_mcp_tool",
  LoadSkill: "skill",
  TeamRun: "team_run",
  TeamCreate: "team_create",
  Agent: "agent",
  SendMessage: "send_message",
  TeamStatus: "team_status",
  TeamStop: "team_stop",
  TaskCreate: "task_create",
  TaskList: "task_list",
  TaskUpdate: "task_update",
};

export function canonicalToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}

export function isToolName(name: string, canonical: string): boolean {
  return canonicalToolName(name) === canonical;
}
