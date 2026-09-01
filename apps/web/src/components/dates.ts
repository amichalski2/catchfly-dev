export const shortDate = (iso: string, withYear = false): string =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  });

export const utcDayLabel = (iso: string): string =>
  `${new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })} UTC`;

export const utcDay = (iso: string): string => new Date(iso).toISOString().slice(0, 10);
