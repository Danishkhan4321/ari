import unittest

from agno_runtime.runtime_state import clear_persisted_session, records_successful_clear


class _FakeDatabase:
    def __init__(self):
        self.calls = []

    def delete_session(self, **kwargs):
        self.calls.append(kwargs)


class RuntimeStateTests(unittest.TestCase):
    def test_only_a_successful_clear_requests_deletion(self):
        self.assertTrue(records_successful_clear(
            "clear_chat_history", {"status": "success"}
        ))
        self.assertFalse(records_successful_clear(
            "clear_chat_history", {"status": "waiting_approval"}
        ))
        self.assertFalse(records_successful_clear(
            "clear_chat_history", {"status": "failure"}
        ))
        self.assertFalse(records_successful_clear(
            "manage_tasks", {"status": "success"}
        ))

    def test_session_delete_is_tenant_scoped_and_optional(self):
        database = _FakeDatabase()
        request = {"session_id": "session-1", "user_id": "ari:user-1"}

        self.assertFalse(clear_persisted_session(database, request, False))
        self.assertEqual(database.calls, [])
        self.assertTrue(clear_persisted_session(database, request, True))
        self.assertEqual(database.calls, [{
            "session_id": "session-1", "user_id": "ari:user-1"
        }])


if __name__ == "__main__":
    unittest.main()
