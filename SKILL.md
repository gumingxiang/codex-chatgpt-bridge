---
name: codex-chatgpt-bridge
description: Coordinate scoped DevSpace MCP and Codex task handoffs on a configured Linux/GPU native or SSH bridge, or the existing Windows lifecycle controller, with explicit user authority and verified recovery.
---

# Codex ChatGPT Bridge

Use Codex as execution and verification owner; use ChatGPT as reasoning and review partner. Read README.md for setup and script usage.

## Service

- Identify the deployed mode and its sole lifecycle owner before operating it. For GPU native, read docs/gpu-operations.md and use the existing SSH Host to the service account's two user systemd units. Public samples do not identify the operator's server or account.
- Windows lifecycle entrypoint for an explicitly selected Windows mode/rollback: scripts/bridge_controller.ps1. Do not start this controller or a second tunnel for an already active GPU owner.
- Configure an existing narrow project root, explicit allowed roots, tunnel mode and port.
- Prefer an existing stable HTTPS route with external mode; worker mode needs a separately provisioned Worker/KV deployment.
- GPU Status/Doctor are read-only. Restart requires both existing units enabled and active, plus task handback; an intentionally disabled unit stays off until explicit On. GPU persistent Off disables/stops both units and retains authorization and journals. Temporary stop is not persistent Off. Windows On/Off/Restart/Reboot retain their controller semantics.
- OAuth persistence for DevSpace 1.0.8 is stateDir/devspace.sqlite. Use a consistent backup of state plus separate config/auth and task journals. Do not generalize deletion of an old oauth-state.json file as GPU Rotate; verify the runtime's revoke procedure and explicit authorization first.
- Before public access, establish the approved project scope and public HTTPS intent from the user's instructions.
- Never print Owner password, API tokens, OAuth tokens, browser cookies or SSH credentials.
- Verify service health and an authenticated read-only MCP tool call before relying on it.
- State whether the service remains running, and use Off when the authorized access task is finished.

## Handoff

MCP carries file requests and the six codex task tools in README.md. Use them for the configured projects; create/send require explicit user instructions and operator taskPermissions. Read back visible results to verify completion, release the bridge subscription when handing back, and authorize interruption separately. Keep requestId/arguments identical on retries and resolve OUTCOME_UNKNOWN before any resubmission. Native/SSH tasks do not implicitly select desktop execution based on the name local.

Chrome/manual message transfer remains available for Task Packet / Action Manifest collaboration. These scripts do not implement a browser driver.

Send a compact Task Packet containing task ID, goal, workspace, permission policy, allowed files/actions, prohibited secrets/actions, tool budget and stop condition.

Default to read-only review. Require an explicit user grant for source writes, installs, external publication or other actions beyond the task's existing authority. Permission levels are instructions, not an OS sandbox; authorized shell has the service account's authority.

Require an Action Manifest: conclusion, evidence inspected, must-fix findings, missing evidence, proposed changes and verification commands. Stop repeated tool failures and ask for the Manifest from gathered evidence.

Codex classifies recommendations, verifies source facts, implements authorized changes and runs checks. ChatGPT's answer alone is not completion evidence.

## Linux and GPU

For the integrated GPU mode, follow integration/README.md and docs/gpu-operations.md. DevSpace remains separately installed; the included Linux units are parameterized examples. Do not copy personal connection details, credentials, state or native dependencies into public artifacts.

For an approved remote task, Codex or explicitly authorized bridge shell may use an existing SSH Host such as gpu-server. SSH is a separate execution path; remote Linux paths do not automatically become Windows MCP file roots. Do not inspect credentials or invent server configuration. Keep long-running process ownership and final verification with Codex.

After deployment changes advertised tools, refresh ChatGPT metadata and test a new conversation; reconnect if the URL changes. Local skill/repository updates alone do not switch production or require reconnecting its unchanged URL.
