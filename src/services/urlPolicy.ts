import { START_PAGE_URL } from "../constants/startPage";

export function normalizeWebUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (value === START_PAGE_URL) return START_PAGE_URL;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) return value;
  return `https://${value}`;
}

export function normalizeHttpUrl(raw: string): string {
  const normalized = normalizeWebUrl(raw);
  if (!normalized || normalized === START_PAGE_URL) return normalized;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString();
  } catch {
    return "";
  }
}
