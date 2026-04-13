"""Validators for A2A protocol objects.

Supports both v0.3 (Pydantic-based, camelCase JSON) and v1.0 (protobuf-based,
camelCase JSON via MessageToDict) formats.

Key differences between v0.3 and v1.0:
- AgentCard: v1.0 uses 'supportedInterfaces' instead of top-level 'url'
             v1.0 drops 'preferredTransport' at top level
             v1.0 'capabilities' still present but schema differs
- TaskStatusUpdateEvent: v1.0 removes the 'final' field
- TaskState: v1.0 uses SCREAMING_SNAKE_CASE strings ('TASK_STATE_COMPLETED')
             v0.3 uses lowercase ('completed')
- Part structure: v1.0 uses flat Part with 'text', 'url', 'raw', 'mediaType'
                  v0.3 uses nested {'file': {'bytes': ..., 'uri': ...}}
"""

from typing import Any


# v1.0 SCREAMING_SNAKE_CASE task states (from protobuf enum name mapping)
_V1_TASK_STATES = frozenset({
    'TASK_STATE_UNSPECIFIED',
    'TASK_STATE_SUBMITTED',
    'TASK_STATE_WORKING',
    'TASK_STATE_COMPLETED',
    'TASK_STATE_FAILED',
    'TASK_STATE_CANCELED',
    'TASK_STATE_CANCELLED',
    'TASK_STATE_INPUT_REQUIRED',
    'TASK_STATE_REJECTED',
    'TASK_STATE_AUTH_REQUIRED',
})

# v0.3 lowercase task states
_V03_TASK_STATES = frozenset({
    'unknown',
    'submitted',
    'working',
    'completed',
    'failed',
    'canceled',
    'cancelled',
    'input-required',
    'rejected',
    'auth-required',
})


def _is_valid_task_state(state: Any) -> bool:
    """Return True if the state value is a known v0.3 or v1.0 task state."""
    if isinstance(state, int):
        # 0..8 correspond to TASK_STATE_UNSPECIFIED..TASK_STATE_AUTH_REQUIRED
        return 0 <= state <= 8  # noqa: PLR2004
    return str(state) in _V1_TASK_STATES or str(state) in _V03_TASK_STATES


def validate_agent_card(card_data: dict[str, Any]) -> list[str]:  # noqa: PLR0912
    """Validate the structure and fields of an agent card.

    Accepts both v0.3 (has top-level 'url') and v1.0 (has 'supportedInterfaces')
    agent card formats.
    """
    errors: list[str] = []

    # --- Required fields (common to both versions) ---
    required_always = frozenset(['name', 'description', 'version', 'skills'])
    for field in required_always:
        if field not in card_data:
            errors.append(f"Required field is missing: '{field}'.")

    # --- URL: v0.3 has top-level 'url', v1.0 uses 'supportedInterfaces' ---
    has_url = 'url' in card_data
    has_supported_interfaces = 'supportedInterfaces' in card_data
    if not has_url and not has_supported_interfaces:
        errors.append(
            "Required field is missing: 'url' or 'supportedInterfaces'."
        )
    elif has_url:
        url = card_data['url']
        if not (
            isinstance(url, str)
            and url.startswith(('http://', 'https://'))
        ):
            errors.append(
                "Field 'url' must be an absolute URL starting with http:// or https://."
            )

    # v1.0 supportedInterfaces validation
    if has_supported_interfaces:
        interfaces = card_data['supportedInterfaces']
        if not isinstance(interfaces, list) or not interfaces:
            errors.append(
                "Field 'supportedInterfaces' must be a non-empty array."
            )
        else:
            for i, iface in enumerate(interfaces):
                if 'url' not in iface:
                    errors.append(
                        f"supportedInterfaces[{i}] is missing required field 'url'."
                    )
                if 'transport' not in iface and 'protocolBinding' not in iface:
                    errors.append(
                        f"supportedInterfaces[{i}] is missing required field 'protocolBinding' (or legacy 'transport')."
                    )

    # --- capabilities ---
    if 'capabilities' in card_data and not isinstance(
        card_data['capabilities'], dict
    ):
        errors.append("Field 'capabilities' must be an object.")

    # --- defaultInputModes / defaultOutputModes (v0.3 camelCase) ---
    # v1.0 uses camelCase via MessageToDict: 'defaultInputModes'
    for field in ['defaultInputModes', 'defaultOutputModes']:
        if field in card_data:
            if not isinstance(card_data[field], list):
                errors.append(f"Field '{field}' must be an array of strings.")
            elif not all(isinstance(item, str) for item in card_data[field]):
                errors.append(f"All items in '{field}' must be strings.")

    # --- skills ---
    if 'skills' in card_data:
        if not isinstance(card_data['skills'], list):
            errors.append(
                "Field 'skills' must be an array of AgentSkill objects."
            )
        elif not card_data['skills']:
            errors.append(
                "Field 'skills' array is empty. Agent must have at least one skill if it performs actions."
            )

    return errors


def _validate_task(data: dict[str, Any]) -> list[str]:
    errors = []
    if 'id' not in data:
        errors.append("Task object missing required field: 'id'.")
    status = data.get('status', {})
    if 'status' not in data or 'state' not in status:
        errors.append("Task object missing required field: 'status.state'.")
    elif not _is_valid_task_state(status.get('state')):
        errors.append(
            f"Task status.state '{status.get('state')}' is not a recognized TaskState value."
        )
    return errors


def _validate_status_update(data: dict[str, Any]) -> list[str]:
    errors = []
    status = data.get('status', {})
    if 'status' not in data or 'state' not in status:
        errors.append(
            "StatusUpdate object missing required field: 'status.state'."
        )
    elif not _is_valid_task_state(status.get('state')):
        errors.append(
            f"StatusUpdate status.state '{status.get('state')}' is not a recognized TaskState value."
        )
    # Note: v1.0 removes the 'final' field from TaskStatusUpdateEvent.
    # We do NOT validate 'final' as required (it's gone in v1.0).
    return errors


def _validate_artifact_update(data: dict[str, Any]) -> list[str]:
    errors = []
    if 'artifact' not in data:
        errors.append(
            "ArtifactUpdate object missing required field: 'artifact'."
        )
    else:
        artifact = data.get('artifact', {})
        parts = artifact.get('parts', [])
        if not isinstance(parts, list) or not parts:
            errors.append("Artifact object must have a non-empty 'parts' array.")
    return errors


def _validate_message(data: dict[str, Any]) -> list[str]:
    errors = []
    parts = data.get('parts', [])
    if not isinstance(parts, list) or not parts:
        errors.append("Message object must have a non-empty 'parts' array.")
    role = data.get('role')
    # v1.0 role may be 'ROLE_AGENT' (protobuf enum string) or 2 (int) or 'agent' (v0.3)
    if role not in ('agent', 'ROLE_AGENT', 2):
        errors.append("Message from agent must have 'role' set to 'agent'.")
    return errors


def validate_message(data: dict[str, Any]) -> list[str]:
    """Validate an incoming message from the agent based on its kind."""
    if 'kind' not in data:
        return ["Response from agent is missing required 'kind' field."]

    kind = data.get('kind')
    kind_validators = {
        'task': _validate_task,
        'status-update': _validate_status_update,
        'artifact-update': _validate_artifact_update,
        'message': _validate_message,
    }

    validator = kind_validators.get(str(kind))
    if validator:
        return validator(data)

    return [f"Unknown message kind received: '{kind}'."]
