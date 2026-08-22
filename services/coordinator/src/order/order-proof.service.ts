import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { ConfigCache } from '../config/config-cache';
import { OrderStatusService } from './order-status.service';
import { requireLp } from './order.params';
import {
  sniffFileType,
  newProofKey,
  deterministicKey,
  EXT_CONTENT_TYPE,
  UploadedFileLike,
} from './upload.util';
import { UploadProofDto } from './dto/upload-proof.dto';
import { canDispute } from './dispute.util';
import { serializeOrderBase } from './order.serialize';

@Injectable()
export class OrderProofService {
  constructor(
    private prisma: PrismaService,
    private cfg: AppConfigService,
    private storage: ObjectStorageService,
    private status: OrderStatusService,
  ) {}

  async uploadProof(
    orderId: string,
    callerAddress: string,
    file: UploadedFileLike | undefined,
    meta: UploadProofDto = {},
  ) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { lp: true } });
    if (!order) throw new NotFoundException('order not found');

    if (order.flow === 'TOP_UP') {
      throw new BadRequestException(
        'payment proof upload does not apply to TOP_UP orders — the user pays fiat there, not the LP',
      );
    }

    const lp = requireLp(order);
    if (callerAddress !== lp.stellarAddress) {
      throw new ForbiddenException('only the assigned LP may upload payment proof for this order');
    }

    const currentOrder = await this.status.refreshOrderStatus(orderId, order);
    if (currentOrder.status !== 'FUNDED') {
      throw new ConflictException('order must be FUNDED to upload payment proof');
    }

    const rrn = meta.rrn ? meta.rrn.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || null : null;

    let proofAmount: bigint | null = null;
    if (meta.paidAmount != null) {
      if (!/^[1-9][0-9]{0,14}$/.test(meta.paidAmount)) {
        throw new BadRequestException('paidAmount must be a positive integer (base units)');
      }
      proofAmount = BigInt(meta.paidAmount);
    }
    const proofPaidAt = meta.paidAt != null ? new Date(meta.paidAt) : null;
    if (proofPaidAt && Number.isNaN(proofPaidAt.getTime())) {
      throw new BadRequestException('paidAt must be a valid timestamp');
    }

    if (proofPaidAt) {
      if (proofPaidAt.getTime() > Date.now() + 5 * 60_000) {
        throw new BadRequestException('payment time cannot be in the future');
      }
      if (proofPaidAt.getTime() < new Date(order.createdAt).getTime()) {
        throw new BadRequestException('payment time cannot predate the order');
      }
    }

    if (rrn) {
      const clash = await this.prisma.order.findFirst({
        where: { proofRrn: rrn, lpId: order.lpId, id: { not: orderId } },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException('this payment reference has already been used for another order');
      }
    }

    const previousProofUrl: string | null = currentOrder.proofUrl ?? null;

    const relativePath = await this.sniffAndStore(file, 'proofs');

    let claimed: { count: number };
    try {
      claimed = await this.prisma.order.updateMany({
        where: { id: orderId, status: 'FUNDED', proofUrl: previousProofUrl },
        data: {
          proofUrl: relativePath,
          proofUploadedAt: new Date(),
          proofRrn: rrn,
          proofAmount,
          proofPaidAt,
        },
      });
    } catch (e) {
      await this.storage.removeObject(relativePath);
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException('this payment reference has already been used for another order');
      }
      throw e;
    }
    if (claimed.count === 0) {
      await this.storage.removeObject(relativePath);
      throw new ConflictException('order must be FUNDED to upload payment proof');
    }

    if (previousProofUrl) await this.storage.removeObject(previousProofUrl);

    const updated = await this.prisma.order.findUnique({ where: { id: orderId } });
    return serializeOrderBase(updated!);
  }

  async getProofFile(
    orderId: string,
    callerAddress: string,
  ): Promise<{ key: string; contentType: string; ext: string }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { lp: true } });
    if (!order) throw new NotFoundException('order not found');

    const isUser = order.userAddress === callerAddress;
    const isLp = order.lp?.stellarAddress === callerAddress;
    const isAdmin = this.cfg.adminAddresses.includes(callerAddress);
    if (!isUser && !isLp && !isAdmin) {
      throw new ForbiddenException('not authorized to view this order’s payment proof');
    }

    if (!order.proofUrl) throw new NotFoundException('no payment proof uploaded for this order');

    const ext = order.proofUrl.split('.').pop() ?? '';
    const contentType = EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream';
    return { key: order.proofUrl, contentType, ext };
  }

  async getDisputeEvidenceFile(
    orderId: string,
    callerAddress: string,
  ): Promise<{ key: string; contentType: string; ext: string }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { lp: true } });
    if (!order) throw new NotFoundException('order not found');

    const isUser = order.userAddress === callerAddress;
    const isLp = order.lp?.stellarAddress === callerAddress;
    const isAdmin = this.cfg.adminAddresses.includes(callerAddress);
    if (!isUser && !isLp && !isAdmin) {
      throw new ForbiddenException('not authorized to view this order’s dispute evidence');
    }

    if (!order.disputeEvidenceUrl) throw new NotFoundException('no dispute evidence uploaded for this order');

    const ext = order.disputeEvidenceUrl.split('.').pop() ?? '';
    const contentType = EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream';
    return { key: order.disputeEvidenceUrl, contentType, ext };
  }

  async uploadDisputeEvidence(
    orderId: string,
    callerAddress: string,
    file: UploadedFileLike | undefined,
  ): Promise<{ evidence_url: string }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { lp: true } });
    if (!order) throw new NotFoundException('order not found');

    const isUser = order.userAddress === callerAddress;
    const isLp = order.lp?.stellarAddress === callerAddress;
    if (!isUser && !isLp) {
      throw new ForbiddenException('only a trade party may upload dispute evidence for this order');
    }

    const currentOrder = await this.status.refreshOrderStatus(orderId, order);
    const config = await this.config();
    if (!canDispute(currentOrder, config)) {
      throw new ConflictException(
        'dispute evidence can only be uploaded while FIAT_PAID or within the post-settlement dispute window',
      );
    }

    const role: 'user' | 'lp' = isUser ? 'user' : 'lp';
    const relativePath = await this.sniffAndStoreDeterministic(file, `${orderId}-${role}`);
    return { evidence_url: relativePath };
  }

  private async sniffAndStore(
    file: UploadedFileLike | undefined,
    kind: 'proofs' | 'evidence',
  ): Promise<string> {
    const sniffed = this.sniffOrThrow(file);
    const key = newProofKey(kind, sniffed.ext);
    try {
      await this.storage.putObject(key, file!.buffer, sniffed.mime);
    } catch {
      throw new ServiceUnavailableException('could not store the uploaded file, retry');
    }
    return key;
  }

  private async sniffAndStoreDeterministic(
    file: UploadedFileLike | undefined,
    key: string,
  ): Promise<string> {
    const sniffed = this.sniffOrThrow(file);
    const objectKey = deterministicKey('evidence', key, sniffed.ext);
    try {
      await this.storage.putObject(objectKey, file!.buffer, sniffed.mime);
    } catch {
      throw new ServiceUnavailableException('could not store the uploaded file, retry');
    }
    await Promise.all(
      Object.keys(EXT_CONTENT_TYPE)
        .filter((ext) => ext !== sniffed.ext)
        .map((ext) => this.storage.removeObject(deterministicKey('evidence', key, ext))),
    );
    return objectKey;
  }

  private sniffOrThrow(file: UploadedFileLike | undefined): { mime: string; ext: string } {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('a file is required');
    }
    const sniffed = sniffFileType(file.buffer);
    if (!sniffed) {
      throw new BadRequestException('unsupported or unrecognized file type (allowed: jpg, png, webp, pdf)');
    }
    if (file.mimetype !== sniffed.mime) {
      throw new BadRequestException('file content does not match its declared Content-Type');
    }
    return sniffed;
  }

  private configCache = new ConfigCache();
  private config() {
    return this.configCache.read(this.prisma, this.cfg.platformWallet);
  }
}
