import { InjectionToken } from '@angular/core';

export const API_URL = new InjectionToken<string>('API_URL');

export abstract class Logger {
  abstract log(message: string): void;
}

export class ConsoleLogger extends Logger {
  log(message: string): void {
    console.log(message);
  }
}

export class Clock {
  now(): number {
    return Date.now();
  }
}

export function clockFactory(): Clock {
  return new Clock();
}
