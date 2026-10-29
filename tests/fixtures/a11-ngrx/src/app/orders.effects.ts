import { Injectable, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { map, switchMap } from 'rxjs';
import { loadOrders, ordersLoaded } from './orders.actions';
import { OrdersApi } from './orders.api';

@Injectable()
export class OrdersEffects {
  private actions$ = inject(Actions);
  private api = inject(OrdersApi);

  load$ = createEffect(() =>
    this.actions$.pipe(
      ofType(loadOrders),
      switchMap(() => this.api.list().pipe(map((ids) => ordersLoaded({ ids })))),
    ),
  );
}
