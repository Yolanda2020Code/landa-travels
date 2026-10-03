import { refreshCertificationRegistry } from "../src/services/certification-registry";

try {
  const snapshot = await refreshCertificationRegistry();
  const counts = snapshot.records.reduce<Record<string, number>>((result, record) => {
    result[record.city] = (result[record.city] ?? 0) + 1;
    return result;
  }, {});
  process.stdout.write(`${JSON.stringify({
    checkedAt: snapshot.checkedAt,
    total: snapshot.records.length,
    cities: counts,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`EU Ecolabel registry refresh failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
}