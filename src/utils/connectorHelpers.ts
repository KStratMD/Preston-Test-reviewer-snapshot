export function mapCommonFields(
  source: Record<string, unknown>,
  fieldMap: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  Object.entries(source).forEach(([key, value]) => {
    const mapped = fieldMap[key] ?? key;
    result[mapped] = value;
  });
  return result;
}

export function mapFromCommonFields(
  source: Record<string, unknown>,
  fieldMap: Record<string, string>,
): Record<string, unknown> {
  const inverseMap = Object.fromEntries(
    Object.entries(fieldMap).map(([k, v]) => [v, k]),
  );
  const result: Record<string, unknown> = {};
  Object.entries(source).forEach(([key, value]) => {
    const mapped = inverseMap[key] ?? key;
    result[mapped] = value;
  });
  return result;
}
