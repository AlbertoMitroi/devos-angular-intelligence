import { Component } from '@angular/core';
import { ButtonComponent } from '@acme/ui';

@Component({ selector: 'admin-root', imports: [ButtonComponent], template: '<acme-button label="Ban" />' })
export class AdminComponent {}
