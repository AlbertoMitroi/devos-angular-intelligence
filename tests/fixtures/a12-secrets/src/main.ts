import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { ReportsComponent } from './app/reports.component';

bootstrapApplication(ReportsComponent, { providers: [provideHttpClient()] });
