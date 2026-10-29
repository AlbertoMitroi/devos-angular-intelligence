import { createAction, props } from '@ngrx/store';

export const loadOrders = createAction('[Orders] Load');
export const ordersLoaded = createAction('[Orders] Loaded', props<{ ids: string[] }>());
