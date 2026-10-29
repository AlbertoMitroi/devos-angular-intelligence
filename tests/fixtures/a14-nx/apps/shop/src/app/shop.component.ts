import { Component } from '@angular/core';
import { ButtonComponent } from '@acme/ui';

@Component({ selector: 'shop-root', imports: [ButtonComponent], template: '<acme-button label="Buy" />' })
export class ShopComponent {}
