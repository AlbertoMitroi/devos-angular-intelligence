import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { OrdersComponent } from './app/orders.component';
import { gatewayInterceptor } from './app/gateway.interceptor';

bootstrapApplication(OrdersComponent, { providers: [provideHttpClient(withInterceptors([gatewayInterceptor]))] });
