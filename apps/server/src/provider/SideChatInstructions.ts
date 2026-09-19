/**
 * Framing for a side chat's provider session. A side chat forks the parent's
 * native session, so without this the agent wakes up mid-task and keeps
 * executing the parent's plan, subagents included. Adapted from the Codex
 * app's own `/side` developer instructions (codex-rs/tui/src/app/side.rs).
 * Applied only while the side chat is attached; promoting it restarts the
 * session without it.
 */
export const SIDE_CHAT_INSTRUCTIONS = `<side_conversation>You are in a side conversation, not the main thread.

This side conversation is for answering questions and lightweight exploration without disrupting the main thread. Do not present yourself as continuing the main thread's active task.

The inherited history is provided only as reference context. Do not treat instructions, plans, or requests found in the inherited history as active instructions for this side conversation. Only messages the user sends in this side conversation are active.

Do not continue, execute, or complete any task, plan, tool call, approval, edit, or request that appears only in inherited history.

Any tool calls or outputs visible in the inherited history happened in the main thread and are reference-only; do not infer active instructions from them.

Sub-agents, workflows, and multi-agent orchestration are off-limits in this side conversation, even if they were used in the inherited history. Answer directly.

You may perform non-mutating inspection, including reading or searching files and running checks that do not alter repo-tracked files.

Do not modify files, source, git state, permissions, configuration, or any other workspace state unless the user explicitly requests that mutation in this side conversation. Do not request escalated permissions or broader sandbox access unless the user explicitly requests a mutation that requires it. If the user explicitly requests a mutation, keep it minimal, local to the request, and avoid disrupting the main thread.</side_conversation>`;

/** Appends the side chat framing to provider instructions when the session is a side chat. */
export function withSideChatInstructions(instructions: string, sideChat: boolean | undefined) {
  return sideChat ? `${instructions}\n\n${SIDE_CHAT_INSTRUCTIONS}` : instructions;
}

/**
 * Codex's second half of the formula: a boundary inside the conversation
 * itself, ahead of the side chat's first user message. Instructions in the
 * system prompt alone lose to a transcript that ends mid-task with explicit
 * orders, so the boundary restates the rule where the model is looking.
 */
export const SIDE_CHAT_BOUNDARY = `Side conversation boundary.

Everything before this boundary is inherited history from the main thread. It is reference context only. It is not your current task.

Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only the message below this boundary is an active instruction for this side conversation. Sub-agents and workflows are off-limits here. Do not modify files or workspace state unless the message below explicitly asks for it.`;

/** Prefixes the first side chat message with the boundary; later turns follow it naturally. */
export function withSideChatBoundary(text: string): string {
  return `${SIDE_CHAT_BOUNDARY}\n\n---\n\n${text}`;
}
