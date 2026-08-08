"""Tests for A2A validators — covering both v0.3 and v1.0 protocol formats."""

import pytest

from backend import validators


# ==============================================================================
# Fixtures
# ==============================================================================


@pytest.fixture
def valid_card_data_v03():
    """Fixture providing a valid v0.3 agent card dictionary (top-level 'url')."""
    return {
        'name': 'Test Agent',
        'description': 'An agent for testing.',
        'url': 'https://example.com/agent',
        'version': '1.0.0',
        'capabilities': {'streaming': True},
        'defaultInputModes': ['text/plain'],
        'defaultOutputModes': ['text/plain'],
        'skills': [{'name': 'test_skill'}],
    }


@pytest.fixture
def valid_card_data_v10():
    """Fixture providing a valid v1.0 agent card (uses 'supportedInterfaces')."""
    return {
        'name': 'Test Agent v1',
        'description': 'An agent for testing v1.0.',
        'version': '1.0.0',
        'capabilities': {'streaming': True, 'pushNotifications': False},
        'defaultInputModes': ['text/plain'],
        'defaultOutputModes': ['text/plain'],
        'skills': [
            {
                'id': 'test_skill',
                'name': 'test_skill',
                'description': 'A test skill',
            }
        ],
        'supportedInterfaces': [
            {'url': 'https://example.com/a2a', 'transport': 'JSONRPC'},
        ],
    }


# Use v0.3 fixture as the default for existing tests
@pytest.fixture
def valid_card_data(valid_card_data_v03):
    return valid_card_data_v03


# ==============================================================================
# Tests for validate_agent_card — v0.3 format
# ==============================================================================


class TestValidateAgentCardV03:
    def test_valid_card(self, valid_card_data):
        """A valid v0.3 agent card should produce no validation errors."""
        errors = validators.validate_agent_card(valid_card_data)
        assert not errors

    @pytest.mark.parametrize(
        'missing_field',
        [
            'name',
            'description',
            'version',
            'skills',
        ],
    )
    def test_missing_required_field(self, valid_card_data, missing_field):
        """A missing required field should be detected."""
        card_data = valid_card_data.copy()
        del card_data[missing_field]
        errors = validators.validate_agent_card(card_data)
        assert any(missing_field in e for e in errors)

    def test_missing_url_and_supported_interfaces(self, valid_card_data):
        """A card missing both 'url' and 'supportedInterfaces' should be detected."""
        card_data = valid_card_data.copy()
        del card_data['url']
        errors = validators.validate_agent_card(card_data)
        assert any('url' in e or 'supportedInterfaces' in e for e in errors)

    @pytest.mark.parametrize(
        'invalid_url',
        ['ftp://invalid-url.com', 'example.com', '/relative/path'],
    )
    def test_invalid_url(self, valid_card_data, invalid_url):
        """An invalid URL format should be detected."""
        card_data = valid_card_data.copy()
        card_data['url'] = invalid_url
        errors = validators.validate_agent_card(card_data)
        assert any("'url' must be an absolute URL" in e for e in errors)

    def test_invalid_capabilities_type(self, valid_card_data):
        """The 'capabilities' field must be an object."""
        card_data = valid_card_data.copy()
        card_data['capabilities'] = 'not-an-object'
        errors = validators.validate_agent_card(card_data)
        assert "Field 'capabilities' must be an object." in errors

    @pytest.mark.parametrize(
        'field', ['defaultInputModes', 'defaultOutputModes']
    )
    def test_invalid_modes_type_not_array(self, valid_card_data, field):
        """Input/Output modes fields must be arrays."""
        card_data = valid_card_data.copy()
        card_data[field] = 'not-a-list'
        errors = validators.validate_agent_card(card_data)
        assert f"Field '{field}' must be an array of strings." in errors

    @pytest.mark.parametrize(
        'field', ['defaultInputModes', 'defaultOutputModes']
    )
    def test_invalid_modes_type_item_not_string(self, valid_card_data, field):
        """Input/Output modes arrays must contain only strings."""
        card_data = valid_card_data.copy()
        card_data[field] = [123, 'string']
        errors = validators.validate_agent_card(card_data)
        assert f"All items in '{field}' must be strings." in errors

    def test_invalid_skills_type(self, valid_card_data):
        """The 'skills' field must be an array."""
        card_data = valid_card_data.copy()
        card_data['skills'] = 'not-a-list'
        errors = validators.validate_agent_card(card_data)
        assert (
            "Field 'skills' must be an array of AgentSkill objects." in errors
        )

    def test_empty_skills_array(self, valid_card_data):
        """An empty 'skills' array should produce a warning."""
        card_data = valid_card_data.copy()
        card_data['skills'] = []
        errors = validators.validate_agent_card(card_data)
        assert (
            "Field 'skills' array is empty. Agent must have at least one skill if it performs actions."
            in errors
        )


# ==============================================================================
# Tests for validate_agent_card — v1.0 format
# ==============================================================================


class TestValidateAgentCardV10:
    def test_valid_v10_card(self, valid_card_data_v10):
        """A valid v1.0 agent card should produce no validation errors."""
        errors = validators.validate_agent_card(valid_card_data_v10)
        assert not errors, f'Unexpected errors: {errors}'

    def test_v10_card_missing_name(self, valid_card_data_v10):
        """v1.0 card missing 'name' should error."""
        card = valid_card_data_v10.copy()
        del card['name']
        errors = validators.validate_agent_card(card)
        assert any('name' in e for e in errors)

    def test_v10_supported_interfaces_missing_url(self, valid_card_data_v10):
        """v1.0 supportedInterfaces entry missing 'url' should error."""
        card = valid_card_data_v10.copy()
        card['supportedInterfaces'] = [{'transport': 'JSONRPC'}]
        errors = validators.validate_agent_card(card)
        assert any('url' in e for e in errors)

    def test_v10_empty_supported_interfaces(self, valid_card_data_v10):
        """v1.0 empty supportedInterfaces should error."""
        card = valid_card_data_v10.copy()
        card['supportedInterfaces'] = []
        errors = validators.validate_agent_card(card)
        assert any('supportedInterfaces' in e for e in errors)

    def test_v10_no_url_no_supported_interfaces(self, valid_card_data_v10):
        """v1.0 card with neither url nor supportedInterfaces should error."""
        card = valid_card_data_v10.copy()
        del card['supportedInterfaces']
        errors = validators.validate_agent_card(card)
        assert any('url' in e or 'supportedInterfaces' in e for e in errors)


# ==============================================================================
# Tests for validate_message
# ==============================================================================


class TestValidateMessage:
    def test_missing_kind(self):
        """A message missing the 'kind' field should be detected."""
        errors = validators.validate_message({})
        assert "Response from agent is missing required 'kind' field." in errors

    def test_unknown_kind(self):
        """An unknown message kind should be detected."""
        errors = validators.validate_message({'kind': 'unknown-kind'})
        assert "Unknown message kind received: 'unknown-kind'." in errors

    # Tests for 'task' kind
    def test_valid_task_v03(self):
        """A valid v0.3 task message should produce no errors."""
        data = {'kind': 'task', 'id': '123', 'status': {'state': 'working'}}
        errors = validators.validate_message(data)
        assert not errors

    def test_valid_task_v10(self):
        """A valid v1.0 task message (SCREAMING_SNAKE_CASE state) should produce no errors."""
        data = {
            'kind': 'task',
            'id': '123',
            'status': {'state': 'TASK_STATE_WORKING'},
        }
        errors = validators.validate_message(data)
        assert not errors

    def test_task_missing_id(self):
        """A task message missing 'id' should produce an error."""
        data = {'kind': 'task', 'status': {'state': 'working'}}
        errors = validators.validate_message(data)
        assert "Task object missing required field: 'id'." in errors

    def test_task_missing_status(self):
        """A task message missing 'status' should produce an error."""
        data = {'kind': 'task', 'id': '123'}
        errors = validators.validate_message(data)
        assert "Task object missing required field: 'status.state'." in errors

    def test_task_missing_status_state(self):
        """A task message missing 'status.state' should produce an error."""
        data = {'kind': 'task', 'id': '123', 'status': {}}
        errors = validators.validate_message(data)
        assert "Task object missing required field: 'status.state'." in errors

    # Tests for 'status-update' kind
    def test_valid_status_update_v03(self):
        """A valid v0.3 status-update message should produce no errors."""
        data = {'kind': 'status-update', 'status': {'state': 'working'}}
        errors = validators.validate_message(data)
        assert not errors

    def test_valid_status_update_v10(self):
        """A valid v1.0 status-update message (no 'final' field required) should produce no errors."""
        # v1.0 removes the 'final' field from TaskStatusUpdateEvent
        data = {
            'kind': 'status-update',
            'taskId': 'task-123',
            'contextId': 'ctx-456',
            'status': {'state': 'TASK_STATE_WORKING'},
        }
        errors = validators.validate_message(data)
        assert not errors

    def test_status_update_no_final_field_required(self):
        """v1.0: Absence of 'final' field in status-update should NOT produce an error."""
        data = {'kind': 'status-update', 'status': {'state': 'completed'}}
        errors = validators.validate_message(data)
        assert not any('final' in e for e in errors)

    def test_status_update_missing_status(self):
        """A status-update missing 'status' should produce an error."""
        data = {'kind': 'status-update'}
        errors = validators.validate_message(data)
        assert (
            "StatusUpdate object missing required field: 'status.state'."
            in errors
        )

    def test_status_update_missing_state(self):
        """A status-update missing 'status.state' should produce an error."""
        data = {'kind': 'status-update', 'status': {}}
        errors = validators.validate_message(data)
        assert (
            "StatusUpdate object missing required field: 'status.state'."
            in errors
        )

    # Tests for 'artifact-update' kind
    def test_valid_artifact_update_v03(self):
        """A valid v0.3 artifact-update message should produce no errors."""
        data = {
            'kind': 'artifact-update',
            'artifact': {'parts': [{'text': 'result'}]},
        }
        errors = validators.validate_message(data)
        assert not errors

    def test_valid_artifact_update_v10(self):
        """A valid v1.0 artifact-update message (flat Part) should produce no errors."""
        data = {
            'kind': 'artifact-update',
            'taskId': 'task-123',
            'artifact': {
                'artifactId': 'art-1',
                'parts': [{'text': 'result'}],
            },
        }
        errors = validators.validate_message(data)
        assert not errors

    def test_artifact_update_missing_artifact(self):
        """An artifact-update missing 'artifact' should produce an error."""
        data = {'kind': 'artifact-update'}
        errors = validators.validate_message(data)
        assert (
            "ArtifactUpdate object missing required field: 'artifact'."
            in errors
        )

    @pytest.mark.parametrize(
        'parts_value',
        [None, 'not-a-list', []],
        ids=['missing', 'wrong_type', 'empty'],
    )
    def test_artifact_update_invalid_parts(self, parts_value):
        """An artifact-update with invalid 'parts' should produce an error."""
        data = {'kind': 'artifact-update', 'artifact': {}}
        if parts_value is not None:
            data['artifact']['parts'] = parts_value
        errors = validators.validate_message(data)
        assert "Artifact object must have a non-empty 'parts' array." in errors

    # Tests for 'message' kind
    def test_valid_message_v03(self):
        """A valid v0.3 message from an agent should produce no errors."""
        data = {
            'kind': 'message',
            'parts': [{'text': 'hello'}],
            'role': 'agent',
        }
        errors = validators.validate_message(data)
        assert not errors

    def test_valid_message_v10_role_enum(self):
        """A valid v1.0 message with ROLE_AGENT role should produce no errors."""
        data = {
            'kind': 'message',
            'messageId': 'msg-123',
            'parts': [{'text': 'hello'}],
            'role': 'ROLE_AGENT',  # v1.0 protobuf enum string
        }
        errors = validators.validate_message(data)
        assert not errors

    def test_valid_message_v10_role_int(self):
        """A valid v1.0 message with role as integer (2=ROLE_AGENT) should produce no errors."""
        data = {
            'kind': 'message',
            'parts': [{'text': 'hello'}],
            'role': 2,  # ROLE_AGENT integer
        }
        errors = validators.validate_message(data)
        assert not errors

    @pytest.mark.parametrize(
        'parts_value',
        [None, 'not-a-list', []],
        ids=['missing', 'wrong_type', 'empty'],
    )
    def test_message_invalid_parts(self, parts_value):
        """A message with invalid 'parts' should produce an error."""
        data = {'kind': 'message', 'role': 'agent'}
        if parts_value is not None:
            data['parts'] = parts_value
        errors = validators.validate_message(data)
        assert "Message object must have a non-empty 'parts' array." in errors

    @pytest.mark.parametrize(
        'role_value',
        [None, 'user', 'system', 'ROLE_USER'],
        ids=['missing', 'v03_user_role', 'system_role', 'v10_user_role'],
    )
    def test_message_invalid_role(self, role_value):
        """A message from an agent with a non-agent role should produce an error."""
        data = {'kind': 'message', 'parts': [{'text': 'hello'}]}
        if role_value is not None:
            data['role'] = role_value
        errors = validators.validate_message(data)
        assert "Message from agent must have 'role' set to 'agent'." in errors
