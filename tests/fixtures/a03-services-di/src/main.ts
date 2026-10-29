import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { CartComponent } from './app/cart.component';

bootstrapApplication(CartComponent, { providers: [provideHttpClient()] });
