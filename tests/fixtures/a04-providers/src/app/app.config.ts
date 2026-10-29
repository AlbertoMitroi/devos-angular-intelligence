import { ApplicationConfig } from '@angular/core';
import { API_URL, Clock, ConsoleLogger, Logger, clockFactory } from './tokens';

export const appConfig: ApplicationConfig = {
  providers: [
    { provide: API_URL, useValue: 'https://api.example.test' },
    { provide: Logger, useClass: ConsoleLogger },
    { provide: Clock, useFactory: clockFactory },
  ],
};
