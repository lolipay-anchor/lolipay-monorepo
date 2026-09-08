import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { acceptedForFunds, popupMayOfferVendor } from '../kyc/screening-requirement';
import { RESOLVER_WINDOW_SECS, signingCutoffSecs } from '../config/contract-limits';
import { refundOpensAt } from '../order/dispute.util';
import { RefundSignerService } from '../stellar/refund-signer.service';
import { StrKey } from '@stellar/stellar-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { Sep12Service, stillInFlight } from '../kyc/sep12.service';
import { RateService } from '../rate/rate.service';
import { OrderService } from '../order/order.service';
import { OrderTxService } from '../order/order-tx.service';
import { OrderStatusService, REFRESH_FROM_CHAIN_STATUSES } from '../order/order-status.service';
import { accountOf } from '../sep10/account-signers.service';
import { AppConfigService } from '../config/app-config.service';
import { baseUnitsToUsdc, fiatDigits, fiatInputAccepted, FIAT_INPUT_REFUSAL, quoteFiat, splitFees } from '../money/money';
import { serializeSep24, Sep24Record, Sep24TransactionJson } from './sep24-transaction';
import {
  SEP24_INTERACTIVE_LINK_TTL_SECS,
  mintInteractiveToken,
  readInteractiveToken,
} from './interactive-token';
import { effectiveIdrPerUsdc, escapeHtml, formatFiat, formatUsdc, interactiveScreen, page, settledRefreshSecs, identityField } from './interactive-page';
import { explorerTxUrl } from './explorer-url';
import { REQUIRED_KYC_FIELDS } from '../kyc/kyc-provider';
import { PersonService } from '../person/person.service';
import { sep24Status } from './sep24-status';
import {
  SEP24_PAGE_DEFAULT,
  SEP24_PAGE_MAX,
  TransactionsQueryDto,
  TransactionQueryDto,
} from './sep24-query.dto';
import { NO_CONTROL_CHARS_RE } from '../order/dto/create-order.dto';

const USER_PAYMENT_METHOD_MAX = 500;

const ORDER_FIELDS = {
  status: true,
  usdcAmount: true,
  fiatAmount: true,
  fiatCurrency: true,
  platformFeeBps: true,
  lpFeeBps: true,
  settlementTxHash: true,
  settledAt: true,
  personId: true,
  ref: true,
  payDeadline: true,
  confirmDeadline: true,
  flow: true,
} as const;

@Injectable()
export class Sep24Service {
  private readonly log = new Logger('Sep24');

  constructor(
    private prisma: PrismaService,
    private cfg: AppConfigService,
    private sep12: Sep12Service,
    private rate: RateService,
    private orders: OrderService,
    private people: PersonService,
    private orderTx: OrderTxService,
    private orderStatus: OrderStatusService,
    private refundSigner: RefundSignerService,
  ) {}

  private async indicativeRateLine(flow: 'TOP_UP' | 'WITHDRAW'): Promise<string> {
    try {
      const config = await this.prisma.config.findUnique({ where: { id: 1 } });
      if (!config) return '';
      if (config.paused) return '<p>This anchor is paused right now; an amount named now will be refused. Try again later.</p>';
      const price = await this.rate.getReferencePrice('IDR');
      const perUsdc = quoteFiat(10_000_000n, price, config.spreadBps, flow === 'WITHDRAW');
      const fee = flow === 'TOP_UP' ? ` A fee of ${(config.platformFeeBps + config.lpFeeBps) / 100}% is taken from the USDC you receive.` : '';
      return `<p>1 USDC ≈ <strong>${escapeHtml(formatFiat(perUsdc))}</strong> IDR right now. This is an estimate; the rate applied is fixed the moment you continue and may differ from this one.${fee}</p>`;
    } catch {
      return '';
    }
  }

  private assets() {
    return { baseUrl: this.cfg.anchorBaseUrl, usdcIssuer: this.cfg.usdcAssetIssuer };
  }

  private assertAssetServed(assetCode: string | undefined): void {
    if (assetCode !== undefined && assetCode !== this.cfg.usdcAssetCode) {
      throw new BadRequestException(`this anchor does not serve ${assetCode}`);
    }
  }

  async info() {
    const config = await this.prisma.config.findFirst();
    const code = this.cfg.usdcAssetCode;
    const bounds = {
      min_amount: baseUnitsToUsdc(config?.minOrder ?? 0n),
      max_amount: baseUnitsToUsdc(config?.maxOrder ?? 0n),
    };
    return {
      deposit: {
        [code]: {
          enabled: true,
          ...bounds,
          fee_percent: ((config?.platformFeeBps ?? 0) + (config?.lpFeeBps ?? 0)) / 100,
        },
      },
      withdraw: { [code]: { enabled: this.cfg.sep24WithdrawEnabled, ...bounds } },
      fee: { enabled: false },
      features: { account_creation: false, claimable_balances: false },
    };
  }

  private async screenedPeople(personIds: string[]): Promise<Set<string>> {
    if (personIds.length === 0) return new Set();
    const rows = await this.prisma.kycVerification.findMany({
      where: { personId: { in: personIds }, OR: [acceptedForFunds(this.cfg.kycRequireAml), { status: 'REJECTED' }] },
      select: { personId: true, status: true },
    });
    const refused = new Set(rows.filter((r) => r.status === 'REJECTED').map((r) => r.personId));
    return new Set(rows.filter((r) => r.status !== 'REJECTED' && !refused.has(r.personId)).map((r) => r.personId));
  }

  private async dress(rows: any[]): Promise<Sep24TransactionJson[]> {
    const screened = await this.screenedPeople([...new Set(rows.map((r) => r.personId))]);
    return rows.map((row) => {
      const record: Sep24Record = {
        id: row.id,
        stellarAccount: row.stellarAccount,
        startedAt: row.startedAt,
        kycVerified: screened.has(row.personId),
        flow: row.flow,
        order: row.order && row.order.personId === row.personId ? row.order : null,
      };
      return serializeSep24(record, this.assets());
    });
  }

  async list(
    subject: string,
    query: TransactionsQueryDto,
  ) {
    this.assertAssetServed(query.asset_code);
    const kindFilter =
      query.kind === 'deposit'
        ? { flow: 'TOP_UP' as const }
        : query.kind === 'withdrawal'
          ? { flow: 'WITHDRAW' as const }
          : {};

    const since = query.no_older_than ? new Date(query.no_older_than) : undefined;
    if (since && Number.isNaN(since.getTime())) {
      throw new BadRequestException('no_older_than is not a readable time');
    }
    const take = Math.min(query.limit ?? SEP24_PAGE_DEFAULT, SEP24_PAGE_MAX);

    const rows = await this.prisma.sep24Transaction.findMany({
      where: {
        stellarAccount: subject,
        ...kindFilter,
        ...(since ? { startedAt: { gte: since } } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take,
      include: { order: { select: ORDER_FIELDS } },
    });
    return { transactions: await this.dress(rows) };
  }

  async one(subject: string, query: TransactionQueryDto) {
    const where = query.id
      ? { id: query.id }
      : query.stellar_transaction_id
        ? { order: { settlementTxHash: query.stellar_transaction_id } }
        : query.external_transaction_id
          ? { order: { ref: query.external_transaction_id } }
          : null;
    if (!where) throw new BadRequestException('name a transaction by id, stellar_transaction_id or external_transaction_id');

    const row = await this.prisma.sep24Transaction.findFirst({
      where: { ...where, stellarAccount: subject },
      include: { order: { select: ORDER_FIELDS } },
    });
    if (!row) throw new NotFoundException('this anchor holds no such transaction for you');
    const [transaction] = await this.dress([row]);
    return { transaction };
  }

  async openInteractive(
    subject: string,
    personId: string,
    body: Record<string, unknown> = {},
    flow: 'TOP_UP' | 'WITHDRAW' = 'TOP_UP',
  ) {
    const assetCode = body.asset_code;
    if (typeof assetCode !== 'string' || assetCode.length === 0) {
      throw new BadRequestException('asset_code is required');
    }
    if (assetCode !== this.cfg.usdcAssetCode) {
      throw new BadRequestException(`this anchor does not serve ${assetCode}`);
    }
    if (body.account !== undefined) {
      if (typeof body.account !== 'string' || body.account.length > 96) {
        throw new BadRequestException('account is not a Stellar address');
      }
      const named = body.account.split(':')[0];
      const known =
        StrKey.isValidEd25519PublicKey(named) ||
        StrKey.isValidMed25519PublicKey(named) ||
        StrKey.isValidContract(named);
      if (!known) {
        throw new BadRequestException('account is not a Stellar address');
      }
      if (body.account !== subject && accountOf(named) !== accountOf(subject)) {
        throw new BadRequestException(
          flow === 'WITHDRAW'
            ? 'this anchor withdraws from the account its token speaks for, and will not take another'
            : 'this anchor credits the account its token speaks for, and will not deposit to another',
        );
      }
    }

    const row = await this.prisma.sep24Transaction.create({
      data: { personId, stellarAccount: subject, assetCode, flow },
    });
    return {
      type: 'interactive_customer_info_needed',
      url: `${this.cfg.anchorBaseUrl}/sep24/interactive/${row.id}?token=${mintInteractiveToken(
        this.cfg,
        row.id,
        subject,
        SEP24_INTERACTIVE_LINK_TTL_SECS,
        'link',
      )}`,
      id: row.id,
    };
  }

  async interactiveState(id: string, token: string) {
    const { account } = readInteractiveToken(this.cfg, token, id);
    const row = await this.prisma.sep24Transaction.findUnique({
      where: { id },
      include: {
        order: {
          select: {
          ...ORDER_FIELDS,
          id: true,
          lpPaymentDetails: true,
          userPaymentDetails: true,
          expiresAt: true,
        },
        },
      },
    });
    if (!row || row.stellarAccount !== account) {
      throw new NotFoundException('this anchor holds no such transaction');
    }
    if (!(await this.people.lookupPerson(row.stellarAccount))) {
      throw new NotFoundException('this anchor holds no such transaction');
    }
    if (row.orderId && REFRESH_FROM_CHAIN_STATUSES.includes((row.order as any)?.status)) {
      const full = await this.prisma.order.findUnique({ where: { id: row.orderId } });
      const fresh = full
        ? await this.orderStatus.refreshOrderStatus(full.id, full).catch(() => null)
        : null;
      if (fresh) (row as any).order = { ...(row.order as any), status: fresh.status };
    }
    const [kyc, screenedElsewhere, refusedAnywhere] = await Promise.all([
      this.prisma.kycVerification.findUnique({ where: { customerRef: row.stellarAccount } }),
      this.prisma.kycVerification.findFirst({
        where: { personId: row.personId, ...acceptedForFunds(this.cfg.kycRequireAml) },
        select: { customerRef: true },
      }),
      this.prisma.kycVerification.findFirst({
        where: { personId: row.personId, status: 'REJECTED' },
        select: { rejectionReason: true },
      }),
    ]);
    return { row, kyc, account, screenedElsewhere, refusedAnywhere };
  }

  private formAction(id: string, suffix: string): string {
    return `/sep24/interactive/${encodeURIComponent(id)}${suffix}`;
  }

  async sessionFromLink(id: string, token: string): Promise<string> {
    const { account } = readInteractiveToken(this.cfg, token, id, 'link');
    const row = await this.prisma.sep24Transaction.findUnique({
      where: { id },
      select: { stellarAccount: true },
    });
    if (!row || row.stellarAccount !== account) {
      throw new NotFoundException('this anchor holds no such transaction');
    }
    if (!(await this.people.lookupPerson(row.stellarAccount))) {
      throw new NotFoundException('this anchor holds no such transaction');
    }
    return mintInteractiveToken(this.cfg, id, row.stellarAccount);
  }

  async renderInteractive(id: string, token: string): Promise<string> {
    const state = await this.interactiveState(id, token);
    const { row, kyc } = state;
    const screen = this.screenFor(row, kyc, state);
    const post = (suffix: string) => this.formAction(id, suffix);
    const withdrawing = row.flow === 'WITHDRAW';
    const credits = withdrawing
      ? `<p>This withdrawal spends USDC from <code>${escapeHtml(row.stellarAccount)}</code>. If that is not your wallet, close this page.</p>`
      : `<p>This deposit credits <code>${escapeHtml(row.stellarAccount)}</code>. If that is not your wallet, close this page.</p>`;

    if (screen === 'refused') {
      return page('Verification refused', `<p>${escapeHtml((state.refusedAnywhere as any)?.rejectionReason ?? (kyc?.status === 'REJECTED' ? kyc.rejectionReason : undefined) ?? 'This identity was refused.')}</p>`);
    }
    if (screen === 'identity') {
      const fields = REQUIRED_KYC_FIELDS.map((f) => identityField(f)).join('');
      return page(
        'Verify your identity',
        `${credits}<p>Next, our verification partner Didit checks your document — have your KTP or passport ready and your phone nearby.</p><form method="post" action="${escapeHtml(post('/identity'))}">${fields}<button type="submit">Continue</button></form>`,
      );
    }
    if (screen === 'waiting_on_identity') {
      const vendor = kyc?.verificationUrl?.startsWith('https://') ? kyc.verificationUrl : null;
      if (vendor && popupMayOfferVendor(kyc)) {
        return page(
          'Verify your identity with Didit',
          `${credits}<a class="btn" href="${escapeHtml(vendor)}" target="_blank" rel="noopener">Open Didit verification</a><p class="hint">On a computer, Didit shows a QR code — scan it with your phone and finish there. Keep this window open; it refreshes itself. Already finished on your phone? This page updates on its own.</p>`,
          10,
        );
      }
      const again = vendor
        ? `<p><a href="${escapeHtml(vendor)}" target="_blank" rel="noopener">Continue verification</a></p>`
        : '';
      return page(
        'Checking your identity',
        `<p>This can take a few minutes. This page refreshes itself.</p>${again}`,
        10,
      );
    }
    if (screen === 'amount') {
      const indicative = await this.indicativeRateLine(withdrawing ? 'WITHDRAW' : 'TOP_UP');
      const bank = withdrawing
        ? '<p><label>The bank account to pay your rupiah into<br><input name="user_payment_method" maxlength="500" required></label></p>'
        : '';
      return page(
        withdrawing ? 'How much would you like to withdraw?' : 'How much would you like to deposit?',
        `${credits}${indicative}<form method="post" action="${escapeHtml(post('/amount'))}"><p><label>Amount in IDR<br><input name="fiat_amount" inputmode="numeric" required></label></p>${bank}<button type="submit">Continue</button></form>`,
      );
    }
    if (screen === 'waiting_on_escrow') {
      return page(
        withdrawing ? 'Preparing your withdrawal' : 'Preparing your deposit',
        withdrawing
          ? '<p>Finding a provider for your withdrawal. This page refreshes itself.</p>'
          : '<p>A liquidity provider is locking the USDC in escrow. This page refreshes itself.</p>',
        10,
      );
    }
    if (screen === 'waiting_on_fiat') {
      const o = row.order as any;
      const until = o.confirmDeadline
        ? new Date(Number(o.confirmDeadline) * 1000).toISOString()
        : null;
      return page(
        'Your USDC is in escrow',
        [
          `<p>The provider says they are sending <strong>${escapeHtml(formatFiat(o.fiatAmount))}</strong> ${escapeHtml(o.fiatCurrency)} to your bank account. This page refreshes itself.</p>`,
          '<p>When they mark it sent, a button appears here. <strong>That is their claim, not proof.</strong> Check your own bank account before you press it — pressing it releases your USDC to them.</p>',
          until
            ? `<p>If they never mark it sent, your USDC can be refunded out of the escrow after <strong>${escapeHtml(until)}</strong> — that route is open to anyone, including you. Once they do mark it sent, it closes, and only your confirmation or a dispute can settle the trade.</p>`
            : '',
        ].join(''),
        30,
      );
    }
    if (screen === 'sign_funding' || screen === 'sign_release') {
      const funding = screen === 'sign_funding';
      const o = row.order as any;
      const signBy = funding ? new Date(signingCutoffSecs(Number(o.payDeadline)) * 1000) : null;
      const config = funding ? await this.prisma.config.findUnique({ where: { id: 1 } }) : null;
      const anchorRefunds = Boolean(config?.autoRefund) && this.refundSigner.isConfigured;
      if (signBy && signBy.getTime() <= Date.now()) {
        return page(
          'This signing window has closed',
          `<p>The signing window for this withdrawal closed at <strong>${escapeHtml(signBy.toISOString())}</strong>. If you did not sign, nothing left your wallet and this withdrawal will expire on its own. If you did sign and it went through, this page will show your escrow once the network confirms it. Start a new withdrawal from your wallet when you are ready.</p>`,
        );
      }
      return page(
        funding ? 'Sign to lock your USDC' : 'Confirm your rupiah arrived',
        [
          funding
            ? [
                `<p>Your wallet will ask you to approve moving <strong>${escapeHtml(formatUsdc(o.usdcAmount))}</strong> USDC into escrow. The provider then pays <strong>${escapeHtml(formatFiat(o.fiatAmount))}</strong> ${escapeHtml(o.fiatCurrency)} to your bank account, and the escrow releases to them when you confirm it arrived. Nothing leaves your wallet until you approve it.</p>`,
                `<p>Rate: 1 USDC ≈ <strong>${escapeHtml(formatFiat(effectiveIdrPerUsdc(o.fiatAmount, o.usdcAmount)))}</strong> ${escapeHtml(o.fiatCurrency)}, fixed for this order. No fee is deducted from the rupiah you receive; the platform's share is inside that rate.</p>`,
                `<p>If the provider never marks the rupiah sent, anyone, including you, can take the USDC back out of the escrow after <strong>${escapeHtml(new Date(Number(refundOpensAt(o)) * 1000).toISOString())}</strong>${anchorRefunds ? ', and this anchor\'s refund service does it for you' : '; this anchor will not do it for you, so the route is open on chain to anyone, including you'}. Once they do mark it sent, only your confirmation or a dispute can move it, decided by the resolver, or by the platform if the resolver does not act within ${RESOLVER_WINDOW_SECS / 3600} hours.</p>`,
                `<p>Sign before <strong>${escapeHtml(signBy!.toISOString())}</strong>. After that the escrow refuses the signature and this withdrawal expires.</p>`,
              ].join('')
            : [
                `<p>The provider says they sent <strong>${escapeHtml(formatFiat(o.fiatAmount))}</strong> ${escapeHtml(o.fiatCurrency)} to:</p>`,
                `<pre>${escapeHtml(o.userPaymentDetails ?? 'the account you gave this anchor')}</pre>`,
                '<p><strong>Only press this if that money is actually in that account.</strong> Pressing it releases your USDC to the provider and cannot be undone. If it has not arrived, do not press it — the escrow still holds your USDC, and you can raise a dispute.</p>',
              ].join(''),
          `<div id="out"><p>Preparing…</p></div>`,
          `<p><button id="go">${funding ? 'Sign in my wallet' : 'I received the rupiah — confirm'}</button></p>`,
          `<script src="${escapeHtml(this.formAction(id, funding ? '/fund.js' : '/release.js'))}"></script>`,
        ].join(''),
      );
    }
    if (screen === 'instructions') {
      const o = row.order as any;
      const due = o.payDeadline ? new Date(Number(o.payDeadline) * 1000).toISOString() : null;
      const { platformFee, lpFee, net } = splitFees(o.usdcAmount, o.platformFeeBps, o.lpFeeBps);
      return page(
        'Send your rupiah',
        [
          `<p>Send <strong>${escapeHtml(formatFiat(o.fiatAmount))}</strong> ${escapeHtml(o.fiatCurrency)} to:</p>`,
          `<pre>${escapeHtml(o.lpPaymentDetails ?? 'your provider will be shown here')}</pre>`,
          `<p>Reference: <strong>${escapeHtml(o.ref ?? '')}</strong></p>`,
          `<p>You receive <strong>${escapeHtml(formatUsdc(net))}</strong> USDC for it: 1 USDC ≈ <strong>${escapeHtml(formatFiat(effectiveIdrPerUsdc(o.fiatAmount, o.usdcAmount)))}</strong> ${escapeHtml(o.fiatCurrency)} on the <strong>${escapeHtml(formatUsdc(o.usdcAmount))}</strong> USDC escrowed, minus a fee of <strong>${escapeHtml(formatUsdc(platformFee + lpFee))}</strong> USDC (${(o.platformFeeBps + o.lpFeeBps) / 100}%), all fixed for this order.</p>`,
          due
            ? `<p><strong>Send it before ${escapeHtml(due)}.</strong> After that a new transfer cannot be matched; one already sent can still be confirmed until <strong>${escapeHtml(new Date(Number(refundOpensAt(o)) * 1000).toISOString())}</strong>, when the escrow returns the USDC to the provider.</p>`
            : '',
          '<p>You may close this window. Your wallet will show the deposit once it settles.</p>',
        ].join(''),
        30,
      );
    }
    const status = sep24Status(row.order as any, row.flow);
    return page(
      withdrawing ? 'Withdrawal status' : 'Deposit status',
      `<p>Status: <strong>${escapeHtml(status)}</strong></p>`,
      settledRefreshSecs(status),
    );
  }

  async submitIdentity(id: string, token: string, fields: Record<string, string>) {
    const state = await this.interactiveState(id, token);
    const { row, kyc } = state;
    if (this.screenFor(row, kyc, state) !== 'identity') {
      throw new ForbiddenException('this transaction is not waiting for identity details');
    }
    await this.sep12.put(row.stellarAccount, fields);
    const after = await this.prisma.kycVerification.findUnique({
      where: { customerRef: row.stellarAccount },
    });
    return after?.verificationUrl ?? null;
  }

  private screenFor(row: any, kyc: any, state?: { screenedElsewhere?: unknown; refusedAnywhere?: unknown }) {
    if (state?.refusedAnywhere) {
      return interactiveScreen({ kycStatus: 'REJECTED', screened: false, orderStatus: null });
    }
    const screened = Boolean(state?.screenedElsewhere);
    const sessionWentStale = kyc?.status === 'PROCESSING' && !stillInFlight(kyc);
    return interactiveScreen({
      kycStatus: screened ? 'ACCEPTED' : sessionWentStale ? 'NEEDS_INFO' : (kyc?.status ?? null),
      screened,
      orderStatus: (row.order?.status as any) ?? null,
      flow: row.flow,
    });
  }

  async fundTx(id: string, token: string) {
    const { row } = await this.interactiveState(id, token);
    if (row.flow !== 'WITHDRAW') {
      throw new BadRequestException('only a withdrawal is funded by the person who opened it');
    }
    const order = row.order as any;
    if (!order) {
      throw new ConflictException('name an amount before this withdrawal can be funded');
    }
    return this.orderTx.buildCreateTradeTx(order.id, accountOf(row.stellarAccount));
  }

  async releaseTx(id: string, token: string) {
    const { row } = await this.interactiveState(id, token);
    if (row.flow !== 'WITHDRAW') {
      throw new BadRequestException('only a withdrawal is released by the person who opened it');
    }
    const order = row.order as any;
    if (!order) {
      throw new ConflictException('this withdrawal has no order to release');
    }
    return this.orderTx.buildConfirmReleaseTx(order.id, accountOf(row.stellarAccount));
  }

  async submitAmount(
    id: string,
    token: string,
    rawAmount: unknown,
    rawPaymentMethod?: unknown,
  ) {
    const state = await this.interactiveState(id, token);
    const { row, kyc } = state;
    if (row.orderId) return;
    if (this.screenFor(row, kyc, state) !== 'amount') {
      throw new ForbiddenException(
        'this transaction is not at the point of naming an amount; reopen the page to see where it is',
      );
    }

    if (typeof rawAmount !== 'string') {
      throw new BadRequestException('name an amount in rupiah');
    }
    if (!fiatInputAccepted(rawAmount)) {
      throw new BadRequestException(FIAT_INPUT_REFUSAL);
    }
    const digits = fiatDigits(rawAmount);
    if (digits.length === 0 || digits.length > 18 || BigInt(digits) === 0n) {
      throw new BadRequestException('name an amount in rupiah');
    }

    let userPaymentMethod: string | undefined;
    if (row.flow === 'WITHDRAW') {
      if (typeof rawPaymentMethod !== 'string') {
        throw new BadRequestException('name the bank account this anchor should pay the rupiah into');
      }
      userPaymentMethod = rawPaymentMethod.trim();
      if (userPaymentMethod.length === 0) {
        throw new BadRequestException('name the bank account this anchor should pay the rupiah into');
      }
      if (userPaymentMethod.length > USER_PAYMENT_METHOD_MAX) {
        throw new BadRequestException('those bank details are too long');
      }
      if (!NO_CONTROL_CHARS_RE.test(userPaymentMethod)) {
        throw new BadRequestException('those bank details contain characters this anchor will not send on');
      }
    }

    const quote = await this.rate.createQuote(accountOf(row.stellarAccount), row.flow, 'BANK', {
      fiatAmount: BigInt(digits),
    });
    const created = await this.orders.createFromQuote(
      accountOf(row.stellarAccount),
      quote.id,
      userPaymentMethod,
    );
    const orderId = String((created.order as Record<string, unknown>).id);
    const linked = await this.prisma.sep24Transaction.updateMany({
      where: { id, orderId: null, stellarAccount: row.stellarAccount },
      data: { orderId },
    });
    if (linked.count !== 1) {
      const undone = await this.prisma.order.updateMany({
        where: { id: orderId, status: { in: ['CREATED', 'MATCHED'] } },
        data: { status: 'CANCELLED' },
      });
      this.log.warn(
        `a second order was opened for SEP-24 transaction ${id} and has been cancelled (${undone.count} row) rather than left holding provider capacity`,
      );
      throw new ConflictException('this transaction was already opened');
    }
  }

  private settlementLine(status: string, hash: string | null | undefined): string {
    if (!hash) return '';
    const label = status === 'refunded' ? 'Refunded on Stellar' : 'Settled on Stellar';
    const url = explorerTxUrl(this.cfg.networkPassphrase, hash);
    const shown = url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(hash)}</a>` : escapeHtml(hash);
    return `<p>${label}: ${shown}</p>`;
  }

  private paymentLine(row: {
    flow: string;
    order: {
      status: string;
      fiatAmount: bigint;
      fiatCurrency: string;
      lpPaymentDetails: string | null;
      ref: string | null;
      payDeadline: bigint | null;
    } | null;
  }): string {
    const o = row.order;
    if (row.flow !== 'TOP_UP' || !o || o.status !== 'FUNDED') return '';
    const due = o.payDeadline ? new Date(Number(o.payDeadline) * 1000).toISOString() : null;
    return [
      `<p>Send <strong>${escapeHtml(formatFiat(o.fiatAmount))}</strong> ${escapeHtml(o.fiatCurrency)} to:</p>`,
      `<pre>${escapeHtml(o.lpPaymentDetails ?? 'your provider will be shown here')}</pre>`,
      `<p>Reference: <strong>${escapeHtml(o.ref ?? '')}</strong></p>`,
      due ? `<p>Send it before <strong>${escapeHtml(due)}</strong>.</p>` : '',
    ].join('');
  }

  async moreInfo(id: string): Promise<string> {
    const row = await this.prisma.sep24Transaction.findUnique({
      where: { id },
      include: { order: { select: { ...ORDER_FIELDS, lpPaymentDetails: true } } },
    });
    if (!row) throw new NotFoundException('this anchor holds no such transaction');
    const [tx] = await this.dress([row]);
    const noun = tx.kind === 'withdrawal' ? 'withdrawal' : 'deposit';
    return [
      '<!doctype html><html lang="en"><head><meta charset="utf-8">',
      `<title>lolipay ${noun}</title></head><body>`,
      `<h1>lolipay ${noun}</h1>`,
      `<p>Status: <strong>${tx.status}</strong></p>`,
      `<p>Started: ${tx.started_at}</p>`,
      this.paymentLine(row),
      this.settlementLine(tx.status, tx.stellar_transaction_id),
      `<p>If something is wrong with this ${noun}, sign in with the same wallet at <a href="https://app.lolipay.app">app.lolipay.app</a>: the order appears there with its evidence, and it shows whether a dispute can still be opened and until when.</p>`,
      '</body></html>',
    ].join('');
  }
}
