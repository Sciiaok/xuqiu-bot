import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, test, expect, vi } from 'vitest';

// Mock next-intl useLocale
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
}));

import ChatMessage from '../ChatMessage';

describe('ChatMessage audio playback', () => {
  const baseProps = {
    role: 'user',
    timestamp: '2025-01-15T10:30:00Z',
  };

  test('audio with wa_media_id renders <audio> element with correct src', () => {
    const { container } = render(
      <ChatMessage
        {...baseProps}
        content=""
        metadata={{ media_type: 'audio', wa_media_id: 'abc123' }}
      />
    );
    const audio = container.querySelector('audio');
    expect(audio).toBeInTheDocument();
    expect(audio).toHaveAttribute('controls');
    expect(audio).toHaveAttribute('src', '/api/media/whatsapp/abc123');
  });

  test('audio with wa_media_id AND text content shows player AND transcription', () => {
    const { container } = render(
      <ChatMessage
        {...baseProps}
        content="This is the transcribed text"
        metadata={{ media_type: 'audio', wa_media_id: 'abc123' }}
      />
    );
    const audio = container.querySelector('audio');
    expect(audio).toBeInTheDocument();
    expect(screen.getByText('This is the transcribed text')).toBeInTheDocument();
  });

  test('audio without wa_media_id and with content text renders only text (no badge, no player)', () => {
    const { container } = render(
      <ChatMessage
        {...baseProps}
        content="Transcription only, no media"
        metadata={{ media_type: 'audio' }}
      />
    );
    const audio = container.querySelector('audio');
    expect(audio).not.toBeInTheDocument();
    // No badge fallback either
    expect(screen.queryByText('🎵')).not.toBeInTheDocument();
    // Text is rendered
    expect(screen.getByText('Transcription only, no media')).toBeInTheDocument();
  });

  test('audio with failed URL falls back to badge with music icon', () => {
    const { container } = render(
      <ChatMessage
        {...baseProps}
        content=""
        metadata={{ media_type: 'audio', wa_media_id: 'bad_id' }}
      />
    );
    // Initially renders <audio>
    let audio = container.querySelector('audio');
    expect(audio).toBeInTheDocument();

    // Simulate error event on the audio element
    fireEvent.error(audio);

    // After error, audio should be gone, badge should appear
    audio = container.querySelector('audio');
    expect(audio).not.toBeInTheDocument();
    expect(screen.getByText('🎵')).toBeInTheDocument();
  });

  test('aggregated messages containing audio sub-messages render audio players', () => {
    const { container } = render(
      <ChatMessage
        {...baseProps}
        content=""
        metadata={{
          aggregated_messages: [
            {
              content: 'Hello text message',
              metadata: {},
            },
            {
              content: '',
              metadata: { media_type: 'audio', wa_media_id: 'agg_audio_1' },
            },
            {
              content: '',
              metadata: { media_type: 'audio', wa_media_id: 'agg_audio_2' },
            },
          ],
        }}
      />
    );
    const audioElements = container.querySelectorAll('audio');
    expect(audioElements).toHaveLength(2);
    expect(audioElements[0]).toHaveAttribute('src', '/api/media/whatsapp/agg_audio_1');
    expect(audioElements[1]).toHaveAttribute('src', '/api/media/whatsapp/agg_audio_2');
    expect(screen.getByText('Hello text message')).toBeInTheDocument();
  });
});
