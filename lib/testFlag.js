// กฎการจำแนก "ข้อมูลทดสอบ" (TEST) เพื่อไม่นำไปปนกับสถิติจริงโดยไม่แจ้งผู้ใช้
const TEST_RE = /test/i;

export function classifyCamera(cameraId) {
  return TEST_RE.test(String(cameraId ?? ''));
}

export function classifyRecord(row) {
  const reasons = [];
  if (classifyCamera(row?.camera_id)) reasons.push('camera_id มีคำว่า test');
  if (TEST_RE.test(String(row?.camera_name ?? ''))) reasons.push('camera_name มีคำว่า test');
  if (TEST_RE.test(String(row?.source ?? ''))) reasons.push('source มีคำว่า test');
  return { isTest: reasons.length > 0, reasons };
}

export function decorateRow(row, { forceTest = false, extraReason = null } = {}) {
  const { isTest, reasons } = classifyRecord(row);
  const finalReasons = [...reasons];
  if (extraReason) finalReasons.push(extraReason);
  return {
    ...row,
    is_test: isTest || forceTest,
    test_reasons: finalReasons,
  };
}

export function decorateRows(rows, opts) {
  return rows.map((row) => decorateRow(row, opts));
}

export function decorateCamera(camera, { forceTest = false, extraReason = null } = {}) {
  const cameraIdIsTest = classifyCamera(camera?.camera_id);
  const cameraNameIsTest = TEST_RE.test(String(camera?.camera_name ?? ''));
  const isTest = forceTest || cameraIdIsTest || cameraNameIsTest;
  const reasons = [];
  if (cameraIdIsTest) reasons.push('camera_id มีคำว่า test');
  if (cameraNameIsTest) reasons.push('camera_name มีคำว่า test');
  if (extraReason) reasons.push(extraReason);
  return { ...camera, is_test: isTest, test_reasons: reasons };
}
