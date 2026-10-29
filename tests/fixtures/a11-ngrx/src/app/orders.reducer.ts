import { createReducer, on } from '@ngrx/store';
import { ordersLoaded } from './orders.actions';

export const ordersReducer = createReducer(
  [] as string[],
  on(ordersLoaded, (_state, { ids }) => ids),
);
