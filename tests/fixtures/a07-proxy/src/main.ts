import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { StatusComponent } from './app/status.component';

bootstrapApplication(StatusComponent, { providers: [provideHttpClient()] });
