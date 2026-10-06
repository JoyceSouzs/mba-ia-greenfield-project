import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VIDEO_STATUS_VALUES, type VideoStatus } from './video-status.enum';

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({
    type: 'enum',
    enum: VIDEO_STATUS_VALUES,
    enumName: 'video_status',
    default: 'draft',
  })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 16, unique: true })
  public_slug: string;

  @Column({ type: 'varchar', length: 255 })
  raw_object_key: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  multipart_upload_id: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_object_key: string | null;

  @Column({ type: 'integer', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  failed_reason: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
