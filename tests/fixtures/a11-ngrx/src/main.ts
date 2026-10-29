import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideStore } from '@ngrx/store';
import { provideEffects } from '@ngrx/effects';
import { OrdersPageComponent } from './app/orders-page.component';
import { ordersReducer } from './app/orders.reducer';
import { OrdersEffects } from './app/orders.effects';

bootstrapApplication(OrdersPageComponent, {
  providers: [provideHttpClient(), provideStore({ orders: ordersReducer }), provideEffects(OrdersEffects)],
});
