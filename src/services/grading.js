// Grade is a deterministic function of numbers already computed live for
// this specific signal - nothing here is per-coin or per-date special-cased.
function gradeSignal({ confidence, expectedValueR, alignedCategories, totalCategories }) {
  const alignmentRatio = totalCategories > 0 ? alignedCategories / totalCategories : 0;

  if (expectedValueR <= 0) return 'D'; // never grade a negative-EV setup above D
  if (confidence >= 85 && expectedValueR >= 1.0 && alignmentRatio >= 0.65) return 'A+';
  if (confidence >= 75 && expectedValueR >= 0.5 && alignmentRatio >= 0.55) return 'A';
  if (confidence >= 65 && expectedValueR > 0 && alignmentRatio >= 0.45) return 'B';
  if (confidence >= 50) return 'C';
  return 'D';
}

module.exports = { gradeSignal };
