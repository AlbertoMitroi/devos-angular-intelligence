import { Checkout } from './app/checkout';
import { StripeGateway } from './app/payments';
import { EmailNotifier } from './app/notifiers';

new Checkout(new StripeGateway(), new EmailNotifier()).run();
