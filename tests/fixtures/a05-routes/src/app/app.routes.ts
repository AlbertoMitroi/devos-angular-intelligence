import { Routes } from '@angular/router';
import { HomeComponent } from './home.component';
import { authGuard } from './auth.guard';

export const routes: Routes = [
  { path: '', component: HomeComponent, pathMatch: 'full' },
  {
    path: 'orders',
    canActivate: [authGuard],
    children: [
      { path: ':id', loadComponent: () => import('./order-detail.component').then((m) => m.OrderDetailComponent) },
    ],
  },
  { path: 'admin', loadChildren: () => import('./admin/admin.routes') },
  { path: 'old', redirectTo: 'orders' },
];
