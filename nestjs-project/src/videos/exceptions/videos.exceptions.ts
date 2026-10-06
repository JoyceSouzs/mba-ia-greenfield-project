import { DomainException } from '../../common/exceptions/domain.exception';

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'Channel not found');
  }
}

export class NotChannelOwnerException extends DomainException {
  constructor() {
    super('NOT_CHANNEL_OWNER', 403, 'You do not own this channel');
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 404, 'Video not ready');
  }
}

export class InvalidStatusTransitionException extends DomainException {
  constructor() {
    super('INVALID_STATUS_TRANSITION', 409, 'Invalid status transition');
  }
}

export class UploadAlreadyCompletedException extends DomainException {
  constructor() {
    super('UPLOAD_ALREADY_COMPLETED', 409, 'Upload already completed');
  }
}

export class SlugGenerationFailedException extends DomainException {
  constructor() {
    super(
      'SLUG_GENERATION_FAILED',
      500,
      'Failed to generate a unique public slug',
    );
  }
}
