const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

function parseReportTimestamp(value, lineNumber) {
  const normalized = value.trim().replace(' ', 'T');
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized);
  const timestamp = hasTimezone
    ? Date.parse(normalized)
    : (() => {
        const match = normalized.match(
          /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/,
        );
        if (!match) return NaN;
        const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '0'] = match;
        const year = Number(yearText);
        const month = Number(monthText);
        const day = Number(dayText);
        const hour = Number(hourText);
        const minute = Number(minuteText);
        const second = Number(secondText);
        const millisecond = Number(fraction.padEnd(3, '0'));
        const local = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
        const check = new Date(local);
        if (
          check.getUTCFullYear() !== year ||
          check.getUTCMonth() !== month - 1 ||
          check.getUTCDate() !== day ||
          hour > 23 ||
          minute > 59 ||
          second > 59
        ) return NaN;
        return local - BANGKOK_OFFSET_MS;
      })();

  if (!Number.isFinite(timestamp)) {
    throw new Error(`บรรทัด ${lineNumber}: เวลาเริ่มไม่ถูกต้อง`);
  }
  return timestamp;
}

export function parsePlaylistReport(text) {
  const records = [];
  const errors = [];
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const fields = trimmed.split('|').map((field) => field.trim());
    if (fields.length < 3) {
      errors.push(`บรรทัด ${index + 1}: รูปแบบไม่ถูกต้อง ต้องมีเวลาเริ่ม | ชื่อสื่อ | ระยะเวลาเล่น (วินาที)`);
      return;
    }
    if (/^(start|เวลาเริ่ม|timestamp)$/i.test(fields[0])) return;

    try {
      const start = parseReportTimestamp(fields[0], index + 1);
      const durationSeconds = Number(fields[2]);
      if (!fields[1]) throw new Error(`บรรทัด ${index + 1}: ไม่พบชื่อสื่อ`);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error(`บรรทัด ${index + 1}: ระยะเวลาเล่นต้องเป็นตัวเลขมากกว่า 0 วินาที`);
      }
      records.push({
        id: index,
        media: fields[1],
        start,
        end: start + durationSeconds * 1000,
        durationSeconds,
      });
    } catch (error) {
      errors.push(error.message);
    }
  });

  return { records, errors };
}

function lowerBound(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle].timestamp <= timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function calculatePlaylistDeltas(records, rows) {
  const sortedRows = rows
    .map((row) => ({
      row,
      timestamp: Date.parse(row.event_time || row.received_at),
    }))
    .filter((item) => Number.isFinite(item.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  return records.map((record) => {
    const afterStart = upperBound(sortedRows, record.start);
    const beforeEnd = lowerBound(sortedRows, record.end);
    const before = sortedRows[afterStart - 1]?.row;
    const after = sortedRows[beforeEnd]?.row || sortedRows[beforeEnd - 1]?.row;
    const delta = (key) => {
      if (!before || !after) return null;
      const beforeValue = Number(before[key]);
      const afterValue = Number(after[key]);
      if (!Number.isFinite(beforeValue) || !Number.isFinite(afterValue)) return null;
      return Math.abs(afterValue - beforeValue);
    };

    return {
      ...record,
      vehicle: delta('total_car'),
      nonVehicle: delta('total_motorcycle'),
      person: delta('total_people'),
      baselineTime: before ? Date.parse(before.event_time || before.received_at) : null,
      endReadingTime: after ? Date.parse(after.event_time || after.received_at) : null,
    };
  });
}
