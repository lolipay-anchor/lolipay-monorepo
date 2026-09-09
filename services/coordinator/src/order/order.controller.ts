import { NO_BRACKETED_FIELD_NAMES } from './multipart-limits';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { OrderService } from './order.service';
import { OrderTxService } from './order-tx.service';
import { OrderProofService } from './order-proof.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { PostDisputeDto } from './dto/post-dispute.dto';
import { UploadProofDto } from './dto/upload-proof.dto';
import { UploadedFileLike } from './upload.util';
import { ObjectStorageService } from '../storage/object-storage.service';

export const UPLOAD_OPTS = {
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4, fieldSize: 4096, parts: 6, ...NO_BRACKETED_FIELD_NAMES },
};

function clampInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = v === undefined ? def : parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

@Controller('orders')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class OrderController {
  constructor(
    private orders: OrderService,
    private tx: OrderTxService,
    private proofs: OrderProofService,
    private storage: ObjectStorageService,
  ) {}

  @Post()
  @Roles('user', 'lp', 'admin')
  async create(@Req() req: any, @Body() dto: CreateOrderDto) {
    return this.orders.createFromQuote(
      req.user.address,
      dto.quoteId,
      dto.userPaymentMethod,
    );
  }

  @Get()
  @Roles('user', 'lp', 'admin')
  async list(
    @Req() req: any,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.orders.listOrders(req.user.address, {
      take: clampInt(limit, 50, 1, 200),
      skip: clampInt(offset, 0, 0, 1_000_000),
    });
  }

  @Get(':id')
  @Roles('user', 'lp', 'admin')
  async getOne(@Req() req: any, @Param('id') id: string) {
    return this.orders.getOrder(id, req.user.address);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles('user', 'lp', 'admin')
  async cancel(@Req() req: any, @Param('id') id: string) {
    return this.orders.cancelOrder(id, req.user.address);
  }

  @Get(':id/tx/mark-paid')
  @Roles('user', 'lp', 'admin')
  async markFiatPaidTx(@Req() req: any, @Param('id') id: string) {
    return this.tx.buildMarkFiatPaidTx(id, req.user.address);
  }

  @Get(':id/tx/create-trade')
  @Roles('user', 'lp', 'admin')
  async createTradeTx(@Req() req: any, @Param('id') id: string) {
    return this.tx.buildCreateTradeTx(id, req.user.address);
  }

  @Get(':id/tx/confirm-release')
  @Roles('user', 'lp', 'admin')
  async confirmReleaseTx(@Req() req: any, @Param('id') id: string) {
    return this.tx.buildConfirmReleaseTx(id, req.user.address);
  }

  @Get(':id/tx/raise-dispute')
  @Roles('user', 'lp', 'admin')
  async raiseDisputeTx(@Req() req: any, @Param('id') id: string) {
    return this.tx.buildRaiseDisputeTx(id, req.user.address);
  }

  @Get(':id/tx/resolve')
  @Roles('admin')
  async resolveTx(
    @Req() req: any,
    @Param('id') id: string,
    @Query('outcome') outcome: string,
  ) {
    if (outcome !== 'release' && outcome !== 'refund') {
      throw new BadRequestException("outcome must be 'release' or 'refund'");
    }
    return this.tx.buildResolveTx(id, req.user.address, outcome);
  }

  @Get(':id/slash-state')
  @Roles('admin')
  async slashState(@Param('id') id: string) {
    const order = await this.tx.orderForSlashState(id);
    const st = await this.tx.slashState(order);
    return {
      trade_amount: st.tradeAmount.toString(),
      recovered: st.recovered.toString(),
      remaining: st.remaining.toString(),
      slash_deadline: st.deadline,
      liability_established: st.liabilityEstablished,
    };
  }

  @Get(':id/tx/slash')
  @Roles('admin')
  async slashTx(
    @Req() req: any,
    @Param('id') id: string,
    @Query('amount') amount: string,
  ) {
    if (!/^[0-9]+$/.test(amount ?? '')) {
      throw new BadRequestException('amount must be a whole number of USDC base units');
    }
    return this.tx.buildSlashTx(id, req.user.address, BigInt(amount));
  }

  @Post(':id/proof')
  @HttpCode(200)
  @Roles('lp', 'admin')
  @UseInterceptors(FileInterceptor('file', UPLOAD_OPTS))
  async uploadProof(
    @Req() req: any,
    @Param('id') id: string,
    @UploadedFile() file: UploadedFileLike | undefined,

    @Body() body: UploadProofDto,
  ) {
    return this.proofs.uploadProof(id, req.user.address, file, body);
  }

  @Get(':id/proof')
  @Roles('user', 'lp', 'admin')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- no @types/express in this lockfile (see main.ts)
  async getProof(@Req() req: any, @Param('id') id: string, @Res({ passthrough: false }) res: any) {
    const { key, contentType, ext } = await this.proofs.getProofFile(id, req.user.address);

    const stream = await this.storage.getObjectStream(key);
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="proof-${id}.${ext}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  }

  @Get(':id/dispute-evidence')
  @Roles('user', 'lp', 'admin')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- no @types/express in this lockfile (see main.ts)
  async getDisputeEvidence(@Req() req: any, @Param('id') id: string, @Res({ passthrough: false }) res: any) {
    const { key, contentType, ext } = await this.proofs.getDisputeEvidenceFile(id, req.user.address);

    const stream = await this.storage.getObjectStream(key);
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="evidence-${id}.${ext}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  }

  @Post(':id/dispute-evidence')
  @HttpCode(200)
  @Roles('user', 'lp', 'admin')
  @UseInterceptors(FileInterceptor('file', UPLOAD_OPTS))
  async uploadDisputeEvidence(
    @Req() req: any,
    @Param('id') id: string,
    @UploadedFile() file: UploadedFileLike | undefined,
  ) {
    return this.proofs.uploadDisputeEvidence(id, req.user.address, file);
  }

  @Post(':id/dispute')
  @HttpCode(200)
  @Roles('user', 'lp', 'admin')
  async postDispute(@Req() req: any, @Param('id') id: string, @Body() dto: PostDisputeDto) {
    return this.orders.postDispute(id, req.user.address, dto.reason, dto.note, dto.evidenceUrl);
  }
}

@Controller('lp')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class LpAssignmentsController {
  constructor(private orders: OrderService) {}

  @Get('assignments')
  @Roles('lp', 'admin')
  async assignments(@Req() req: any) {
    return this.orders.listLpAssignments(req.user.address);
  }
}
