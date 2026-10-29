# eShopOnAbp apps/angular: ground truth

Written from the sources of `abpframework/eShopOnAbp` at `7bfed7a322d16b34a5a66208c03486fa5dfacee9` (2025-01-08) before the engine's first run on it. Paths are relative to `apps/angular/`. Found with `grep -rln "RestService"`, `grep -rn "HttpClient\b"`, `grep -rn "withUrl\|HubConnection"`, `grep -rn "@ngrx"` and the routing modules listed by `grep -rln "Routes\b\|RouterModule"`.

## Projects

`angular.json`: application `EShopOnAbp` (root `""`, so `apps/angular`), libraries `catalog` (`projects/catalog`) and `ordering` (`projects/ordering`). The application reaches the libraries through tsconfig `paths` (`@eshoponabp/catalog`, `@eshoponabp/ordering` and their `/config` entries). Environments: `src/environments/environment.ts` (default) and `environment.prod.ts` (configuration `production`, file replacement).

## HTTP calls: 17, all through `RestService.request` (no `HttpClient`, no SignalR, no NgRx)

| Caller | Method | canonicalRoute | Line |
|---|---|---|---|
| `PublicProductService.get` | GET | `/api/catalog/public-product/{}` | `projects/catalog/src/lib/proxy/products/public-product.service.ts:13` |
| `PublicProductService.getList` | GET | `/api/catalog/public-product` | `...public-product.service.ts:20` |
| `ProductService.create` | POST | `/api/catalog/product` | `projects/catalog/src/lib/proxy/products/product.service.ts:13` |
| `ProductService.delete` | DELETE | `/api/catalog/product/{}` | `...product.service.ts:21` |
| `ProductService.get` | GET | `/api/catalog/product/{}` | `...product.service.ts:28` |
| `ProductService.getList` | GET | `/api/catalog/product` | `...product.service.ts:35` |
| `ProductService.getListPaged` | GET | `/api/catalog/product/paged` | `...product.service.ts:42` |
| `ProductService.update` | PUT | `/api/catalog/product/{}` | `...product.service.ts:50` |
| `OrderService.create` | POST | `/api/ordering/order` | `projects/ordering/src/lib/proxy/orders/order.service.ts:13` |
| `OrderService.get` | GET | `/api/ordering/order/{}` | `...order.service.ts:21` |
| `OrderService.getByOrderNo` | GET | `/api/ordering/order/by-order-no` | `...order.service.ts:28` |
| `OrderService.getDashboard` | GET | `/api/ordering/order/dashboard` | `...order.service.ts:36` |
| `OrderService.getListPaged` | GET | `/api/ordering/order/paged` | `...order.service.ts:44` |
| `OrderService.getMyOrders` | GET | `/api/ordering/order/my-orders` | `...order.service.ts:52` |
| `OrderService.getOrders` | GET | `/api/ordering/order/orders` | `...order.service.ts:60` |
| `OrderService.setAsCancelled` | POST | `/api/ordering/order/{}/set-as-cancelled` | `...order.service.ts:68` |
| `OrderService.setAsShipped` | POST | `/api/ordering/order/{}/set-as-shipped` | `...order.service.ts:75` |

Base address: `apiName` is the class property `apiName = 'Catalog'` (product services) or `'Ordering'` (order service), passed as `{ apiName: this.apiName }`. ABP reads `environment.apis[apiName].url`, falling back to `apis.default.url` when the key is absent.

- Default configuration: `environment.apis.Catalog.url` = `https://localhost:44354`, `environment.apis.Ordering.url` = `https://localhost:44356`.
- `production`: `environment.prod.ts` has only `apis.default` (`https://localhost:44394`) and a `remoteEnv` (`/getEnvConfig`, `deepmerge`) merged at run time. The production base cannot be known from the repository: the expected resolution is `candidate`, with a reason naming the missing key.

## Routes: 15, all reached from `RouterModule.forRoot` (none unreached)

| Full path | Target | Declared in |
|---|---|---|
| `/` | `loadChildren` `HomeModule` (pathMatch full) | `src/app/app-routing.module.ts:6` |
| `/account` | `loadChildren` `@abp/ng.account` `AccountModule` (package) | `src/app/app-routing.module.ts:11` |
| `/identity` | `loadChildren` `@abp/ng.identity` `IdentityModule` (package) | `:15` |
| `/tenant-management` | `loadChildren` `@abp/ng.tenant-management` `TenantManagementModule` (package) | `:19` |
| `/setting-management` | `loadChildren` `@abp/ng.setting-management` `SettingManagementModule` (package) | `:24` |
| `/catalog` | `loadChildren` `CatalogModule` | `:29` |
| `/ordering` | `loadChildren` `OrderingModule` | `:33` |
| `/` | `HomeComponent` | `src/app/home/home-routing.module.ts:6` |
| `/catalog` | `redirectTo: products` (pathMatch full) | `projects/catalog/src/catalog-routing.module.ts:5` |
| `/catalog/products` | `loadChildren` `ProductModule` | `projects/catalog/src/catalog-routing.module.ts:7` |
| `/catalog/products` | `ProductComponent`, `canActivate` `AuthGuard`, `PermissionGuard` (package) | `projects/catalog/src/pages/product/product-routing.module.ts:9` |
| `/ordering` | `loadChildren` `DashboardModule` (pathMatch full) | `projects/ordering/src/ordering-routing.module.ts:6` |
| `/ordering/orders` | `loadChildren` `OrdersModule` | `projects/ordering/src/ordering-routing.module.ts:11` |
| `/ordering` | `DashboardComponent` (guard commented out) | `projects/ordering/src/pages/dashboard/dashboard-routing.module.ts:7` |
| `/ordering/orders` | `OrdersComponent` | `projects/ordering/src/pages/orders/orders-routing.module.ts:5` |

The four ABP package modules' own routes live in `node_modules` and are outside the repository.
