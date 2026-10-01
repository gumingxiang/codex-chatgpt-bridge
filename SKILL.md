---
name: codex-chatgpt-bridge
description: Coordinate Codex local execution, ChatGPT reasoning/review, Chrome message handoffs, and a scoped DevSpace MCP service, including optional Linux/GPU work through separately configured SSH.
---

# Codex ChatGPT Bridge

Use Codex as execution and verification owner; use ChatGPT as reasoning and review partner. Read README.md for setup and script usage.

## Service

- Windows lifecycle entrypoint: scripts/bridge_controller.ps1.
- Configure an existing narrow project root, explicit allowed roots, tunnel mode and port.
- Prefer an existing stable HTTPS route with external mode; worker mode needs a separately provisioned Worker/KV deployment.
- Use On, Off, Status, Doctor and Restart/Reboot. Reboot refuses intentionally stopped state until On is used.
- Before public access, establish the approved project scope and public HTTPS intent from the user's instructions.
- Never print Owner password, API tokens, OAuth tokens, browser cookies or SSH credentials.
- Verify service health and an authenticated read-only MCP tool call before relying on it.
- State whether the service remains running, and use Off when the authorized access task is finished.

## Handoff

Chrome carries task messages; MCP carries tool requests. Use an available compatible browser tool or ask the operator to transfer the packet/reply manually. These scripts do not implement a browser driver.

Send a compact Task Packet containing task ID, goal, workspace, permission policy, allowed files/actions, prohibited secrets/actions, tool budget and stop condition.

Default to read-only review. Require an explicit user grant for source writes, installs, external publication or other actions beyond the task's existing authority. Permission levels are instructions, not an OS sandbox; authorized shell has the service account's authority.

Require an Action Manifest: conclusion, evidence inspected, must-fix findings, missing evidence, proposed changes and verification commands. Stop repeated tool failures and ask for the Manifest from gathered evidence.

Codex classifies recommendations, verifies source facts, implements authorized changes and runs checks. ChatGPT's answer alone is not completion evidence.

## Linux and GPU

DevSpace may run directly on Linux behind HTTPS/OAuth/MCP; the included lifecycle scripts are Windows-specific. Linux processes need the operator's own management.

For an approved remote task, Codex or explicitly authorized bridge shell may use an existing SSH Host such as gpu-server. SSH is a separate execution path; remote Linux paths do not automatically become Windows MCP file roots. Do not inspect credentials or invent server configuration. Keep long-running process ownership and final verification with Codex.
