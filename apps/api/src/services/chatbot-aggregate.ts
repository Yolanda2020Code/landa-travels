export function sampleState(sampleSize: number, minimum = 5): "ready" | "insufficient_sample" {
  return sampleSize < minimum ? "insufficient_sample" : "ready";
}

export function rate(numerator: number, denominator: number, minimum = 5) {
  return { value: denominator ? numerator / denominator : 0, numerator, denominator, sampleSize: denominator, state: sampleState(denominator, minimum) };
}