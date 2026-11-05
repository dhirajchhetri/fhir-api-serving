import pathlib
import unittest

from flatten_export import flatten_ndjson


ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "data" / "synthetic" / "export.ndjson"


class FlattenExportTest(unittest.TestCase):
    def test_fixture_rows(self) -> None:
        rows = flatten_ndjson(FIXTURE.read_text().splitlines())
        observations = [row for row in rows if row["row_type"] == "observation"]
        tasks = [row for row in rows if row["row_type"] == "task"]
        self.assertEqual(observations[0]["patient_id"], "pat-1001")
        self.assertEqual(observations[0]["code"], "area-cm2")
        self.assertEqual(observations[0]["value"], 12)
        self.assertEqual(tasks[0]["status"], "requested")
        self.assertEqual(tasks[0]["patient_id"], "pat-1002")

    def test_ignores_blank_lines_and_unrelated_resources(self) -> None:
        rows = flatten_ndjson(["", '{"resourceType":"Patient","id":"pat-1"}', ""])
        self.assertEqual(rows, [])


if __name__ == "__main__":
    unittest.main()
