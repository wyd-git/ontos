import { fail } from "./error.ts";
import { requireString } from "./text.ts";

declare const canonicalIntegerBrand: unique symbol;
declare const canonicalDecimalBrand: unique symbol;
declare const canonicalDateBrand: unique symbol;
declare const canonicalTimestampBrand: unique symbol;
declare const canonicalUuidBrand: unique symbol;

export type CanonicalInteger = string & { readonly [canonicalIntegerBrand]: true };
export type CanonicalDecimal = string & { readonly [canonicalDecimalBrand]: true };
export type CanonicalDate = string & { readonly [canonicalDateBrand]: true };
export type CanonicalTimestamp = string & { readonly [canonicalTimestampBrand]: true };
export type CanonicalUuid = string & { readonly [canonicalUuidBrand]: true };

export interface DecimalFormat {
  readonly precision: number;
  readonly scale: number;
}

export const INTEGER_MINIMUM = -(2n ** 63n);
export const INTEGER_MAXIMUM = 2n ** 63n - 1n;
export const DECIMAL_MAXIMUM_PRECISION = 38;
export const DECIMAL_MAXIMUM_SCALE = 18;

const integerPattern = /^-?(?:0|[1-9][0-9]*)$/u;
const decimalPattern = /^-?(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/u;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const timestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/u;
const uuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

const microsecondsPerSecond = 1_000_000n;
const microsecondsPerMinute = 60n * microsecondsPerSecond;
const microsecondsPerHour = 60n * microsecondsPerMinute;
const microsecondsPerDay = 24n * microsecondsPerHour;

export function canonicalizeInteger(input: unknown): CanonicalInteger {
  const value = requireString(input);
  if (!integerPattern.test(value)) {
    fail(
      "INTEGER_FORMAT_INVALID",
      "Integer must be a canonical base-10 string without a plus sign or leading zeroes.",
    );
  }

  const parsed = BigInt(value);
  if (parsed < INTEGER_MINIMUM || parsed > INTEGER_MAXIMUM) {
    fail("INTEGER_VALUE_OUT_OF_RANGE", "Integer must fit in the signed 64-bit range.");
  }
  return parsed.toString(10) as CanonicalInteger;
}

export function compareCanonicalIntegers(left: CanonicalInteger, right: CanonicalInteger): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function validateDecimalFormat(format: DecimalFormat): void {
  if (
    !Number.isSafeInteger(format.precision) ||
    !Number.isSafeInteger(format.scale) ||
    format.precision < 1 ||
    format.precision > DECIMAL_MAXIMUM_PRECISION ||
    format.scale < 0 ||
    format.scale > DECIMAL_MAXIMUM_SCALE ||
    format.scale > format.precision
  ) {
    fail(
      "DECIMAL_SCHEMA_INVALID",
      "Decimal requires precision 1..38 and scale 0..18 with scale <= precision.",
    );
  }
}

export function canonicalizeDecimal(input: unknown, format: DecimalFormat): CanonicalDecimal {
  validateDecimalFormat(format);
  const value = requireString(input);
  const match = decimalPattern.exec(value);
  if (match === null) {
    fail(
      "DECIMAL_FORMAT_INVALID",
      "Decimal must be a base-10 string without exponent, plus sign, or leading zeroes.",
    );
  }

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const separator = unsigned.indexOf(".");
  const integerPart = separator === -1 ? unsigned : unsigned.slice(0, separator);
  const fractionalPart = separator === -1 ? "" : unsigned.slice(separator + 1);
  const integerDigits = integerPart === "0" ? 0 : integerPart.length;

  if (fractionalPart.length > format.scale || integerDigits > format.precision - format.scale) {
    fail(
      "DECIMAL_VALUE_OUT_OF_RANGE",
      `Decimal does not fit precision ${format.precision}, scale ${format.scale}.`,
    );
  }

  const paddedFraction = fractionalPart.padEnd(format.scale, "0");
  const isZero = integerPart === "0" && !/[1-9]/u.test(paddedFraction);
  const sign = negative && !isZero ? "-" : "";
  const fraction = format.scale === 0 ? "" : `.${paddedFraction}`;
  return `${sign}${integerPart}${fraction}` as CanonicalDecimal;
}

export function decimalToUnscaled(value: CanonicalDecimal): bigint {
  return BigInt(value.replace(".", ""));
}

export function compareCanonicalDecimals(left: CanonicalDecimal, right: CanonicalDecimal): number {
  const leftScale = fractionalDigits(left);
  const rightScale = fractionalDigits(right);
  const commonScale = Math.max(leftScale, rightScale);
  const leftValue = decimalToUnscaled(left) * 10n ** BigInt(commonScale - leftScale);
  const rightValue = decimalToUnscaled(right) * 10n ** BigInt(commonScale - rightScale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function fractionalDigits(value: CanonicalDecimal): number {
  const separator = value.indexOf(".");
  return separator === -1 ? 0 : value.length - separator - 1;
}

export function canonicalizeDate(input: unknown): CanonicalDate {
  const value = requireString(input);
  const match = datePattern.exec(value);
  if (match === null) {
    fail("DATE_INVALID", "Date must use fixed-width YYYY-MM-DD format.");
  }
  const year = requiredNumber(match, 1);
  const month = requiredNumber(match, 2);
  const day = requiredNumber(match, 3);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    fail("DATE_INVALID", "Date must be a real Gregorian date in years 0001..9999.");
  }
  return value as CanonicalDate;
}

export function canonicalizeTimestamp(input: unknown): CanonicalTimestamp {
  const value = requireString(input);
  const match = timestampPattern.exec(value);
  if (match === null) {
    fail(
      "TIMESTAMP_INVALID",
      "Timestamp must be RFC3339 with seconds, an explicit zone, and at most six fractional digits.",
    );
  }

  const year = requiredNumber(match, 1);
  const month = requiredNumber(match, 2);
  const day = requiredNumber(match, 3);
  const hour = requiredNumber(match, 4);
  const minute = requiredNumber(match, 5);
  const second = requiredNumber(match, 6);
  const fraction = match[7] ?? "";
  const zone = requiredGroup(match, 8);

  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    fail("TIMESTAMP_INVALID", "Timestamp contains an invalid Gregorian date or clock time.");
  }

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const sign = requiredGroup(match, 9);
    const offsetHour = requiredNumber(match, 10);
    const offsetMinute = requiredNumber(match, 11);
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0) ||
      (sign === "-" && offsetHour === 0 && offsetMinute === 0)
    ) {
      fail(
        "TIMESTAMP_INVALID",
        "Timestamp offset must be known and within -14:00..+14:00; -00:00 is ambiguous.",
      );
    }
    offsetMinutes = (sign === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }

  const microseconds = BigInt(fraction.padEnd(6, "0"));
  const localDays = BigInt(daysFromCivil(year, month, day));
  const utcMicroseconds =
    localDays * microsecondsPerDay +
    BigInt(hour) * microsecondsPerHour +
    BigInt(minute) * microsecondsPerMinute +
    BigInt(second) * microsecondsPerSecond +
    microseconds -
    BigInt(offsetMinutes) * microsecondsPerMinute;

  return formatUtcTimestamp(utcMicroseconds);
}

export function timestampToEpochMicroseconds(value: CanonicalTimestamp): bigint {
  const match = timestampPattern.exec(value);
  if (match === null || requiredGroup(match, 8) !== "Z") {
    fail("TIMESTAMP_INVALID", "Expected a canonical UTC timestamp.");
  }
  const year = requiredNumber(match, 1);
  const month = requiredNumber(match, 2);
  const day = requiredNumber(match, 3);
  const hour = requiredNumber(match, 4);
  const minute = requiredNumber(match, 5);
  const second = requiredNumber(match, 6);
  const fraction = requiredGroup(match, 7);
  return (
    BigInt(daysFromCivil(year, month, day)) * microsecondsPerDay +
    BigInt(hour) * microsecondsPerHour +
    BigInt(minute) * microsecondsPerMinute +
    BigInt(second) * microsecondsPerSecond +
    BigInt(fraction)
  );
}

export function compareCanonicalTimestamps(
  left: CanonicalTimestamp,
  right: CanonicalTimestamp,
): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalizeUuid(input: unknown): CanonicalUuid {
  const value = requireString(input);
  if (!uuidPattern.test(value)) {
    fail("UUID_INVALID", "UUID must use the 8-4-4-4-12 hexadecimal form.");
  }
  return value.toLowerCase() as CanonicalUuid;
}

function formatUtcTimestamp(epochMicroseconds: bigint): CanonicalTimestamp {
  const days = floorDivide(epochMicroseconds, microsecondsPerDay);
  const dayMicroseconds = epochMicroseconds - days * microsecondsPerDay;
  const { year, month, day } = civilFromDays(Number(days));
  if (year < 1 || year > 9_999) {
    fail("TIMESTAMP_INVALID", "UTC normalization must remain within years 0001..9999.");
  }

  const hour = dayMicroseconds / microsecondsPerHour;
  const afterHour = dayMicroseconds % microsecondsPerHour;
  const minute = afterHour / microsecondsPerMinute;
  const afterMinute = afterHour % microsecondsPerMinute;
  const second = afterMinute / microsecondsPerSecond;
  const fraction = afterMinute % microsecondsPerSecond;

  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(Number(hour), 2)}:${pad(
    Number(minute),
    2,
  )}:${pad(Number(second), 2)}.${pad(Number(fraction), 6)}Z` as CanonicalTimestamp;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysFromCivil(yearInput: number, month: number, day: number): number {
  const year = yearInput - (month <= 2 ? 1 : 0);
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function civilFromDays(daysInput: number): { year: number; month: number; day: number } {
  const days = daysInput + 719_468;
  const era = Math.floor(days / 146_097);
  const dayOfEra = days - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1_460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  let year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  return { year, month, day };
}

function floorDivide(dividend: bigint, divisor: bigint): bigint {
  const quotient = dividend / divisor;
  const remainder = dividend % divisor;
  return remainder < 0n ? quotient - 1n : quotient;
}

function requiredGroup(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) fail("TIMESTAMP_INVALID", "Timestamp parser invariant failed.");
  return value;
}

function requiredNumber(match: RegExpExecArray, index: number): number {
  return Number(requiredGroup(match, index));
}

function pad(value: number, width: number): string {
  return value.toString(10).padStart(width, "0");
}
