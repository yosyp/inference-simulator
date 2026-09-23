// Inverse of the standard normal CDF: Wichura's algorithm AS 241 (PPND16), Applied Statistics
// 37(3), 1988. Three rational approximations (central, tail, far tail) give about 1e-16 relative
// accuracy with no refinement step and no erfc. The coefficients are the published 20-digit values,
// written as the doubles they round to. normal.test.ts checks the result against 60-digit values.

// Central region, |p - 0.5| <= 0.425: numerator A, denominator B (B0 = 1).
const A0 = 3.3871328727963665;
const A1 = 133.14166789178438;
const A2 = 1971.5909503065513;
const A3 = 13731.69376550946;
const A4 = 45921.95393154987;
const A5 = 67265.7709270087;
const A6 = 33430.57558358813;
const A7 = 2509.0809287301227;
const B1 = 42.31333070160091;
const B2 = 687.1870074920579;
const B3 = 5394.196021424751;
const B4 = 21213.794301586597;
const B5 = 39307.89580009271;
const B6 = 28729.085735721943;
const B7 = 5226.495278852854;

// Tail, r = sqrt(-ln(min(p, 1 - p))) <= 5: numerator C, denominator D (D0 = 1).
const C0 = 1.4234371107496835;
const C1 = 4.630337846156546;
const C2 = 5.769497221460691;
const C3 = 3.6478483247632045;
const C4 = 1.2704582524523684;
const C5 = 0.2417807251774506;
const C6 = 0.022723844989269184;
const C7 = 0.0007745450142783414;
const D1 = 2.053191626637759;
const D2 = 1.6763848301838038;
const D3 = 0.6897673349851;
const D4 = 0.14810397642748008;
const D5 = 0.015198666563616457;
const D6 = 0.0005475938084995345;
const D7 = 1.0507500716444169e-9;

// Far tail, r > 5 (p below about 1.4e-11): numerator E, denominator F (F0 = 1).
const E0 = 6.657904643501103;
const E1 = 5.463784911164114;
const E2 = 1.7848265399172913;
const E3 = 0.29656057182850487;
const E4 = 0.026532189526576124;
const E5 = 0.0012426609473880784;
const E6 = 2.7115555687434876e-5;
const E7 = 2.0103343992922881e-7;
const F1 = 0.599832206555888;
const F2 = 0.1369298809227358;
const F3 = 0.014875361290850615;
const F4 = 0.0007868691311456133;
const F5 = 1.8463183175100548e-5;
const F6 = 1.421511758316446e-7;
const F7 = 2.0442631033899397e-15;

/**
 * The standard normal quantile Φ⁻¹(p): the x with P(Z ≤ x) = p. Returns -Infinity at p = 0,
 * Infinity at p = 1, and NaN outside [0, 1]. Accurate to about 1e-15 absolute over
 * (1e-10, 1 - 1e-10). It uses Math.log and Math.sqrt, so other JS engines may differ in the last
 * bit (02 §12).
 */
export function normalQuantile(p: number): number {
  const q = p - 0.5;
  if (q >= -0.425 && q <= 0.425) {
    const r = 0.180625 - q * q;
    return (
      (q * (((((((A7 * r + A6) * r + A5) * r + A4) * r + A3) * r + A2) * r + A1) * r + A0)) /
      (((((((B7 * r + B6) * r + B5) * r + B4) * r + B3) * r + B2) * r + B1) * r + 1)
    );
  }
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  // For p > 0.5, 1 - p is exact (Sterbenz), so the upper tail keeps its accuracy.
  let r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p));
  let x: number;
  if (r <= 5) {
    r -= 1.6;
    x =
      (((((((C7 * r + C6) * r + C5) * r + C4) * r + C3) * r + C2) * r + C1) * r + C0) /
      (((((((D7 * r + D6) * r + D5) * r + D4) * r + D3) * r + D2) * r + D1) * r + 1);
  } else {
    r -= 5;
    x =
      (((((((E7 * r + E6) * r + E5) * r + E4) * r + E3) * r + E2) * r + E1) * r + E0) /
      (((((((F7 * r + F6) * r + F5) * r + F4) * r + F3) * r + F2) * r + F1) * r + 1);
  }
  return q < 0 ? -x : x;
}
