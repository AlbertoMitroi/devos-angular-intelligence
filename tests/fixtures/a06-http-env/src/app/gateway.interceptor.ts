import { HttpInterceptorFn } from '@angular/common/http';
import { environment } from '../environments/environment';

export const gatewayInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.url.startsWith('http')) {
    return next(req);
  }
  return next(req.clone({ url: `${environment.gatewayUrl}${req.url}` }));
};
