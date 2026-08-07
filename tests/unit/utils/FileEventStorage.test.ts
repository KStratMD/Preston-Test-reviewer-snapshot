/**
 * File Event Storage Unit Tests
 * Tests for file-based event persistence
 */

// Mock fs
jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

import fs from 'fs';
import { FileEventStorage } from '../../../src/utils/FileEventStorage';
import type { DomainEvent } from '../../../src/utils/EventBus';

const mockFs = fs as jest.Mocked<typeof fs>;

describe('FileEventStorage', () => {
  let storage: FileEventStorage;
  const testEvent: DomainEvent = {
    type: 'test.event',
    payload: { data: 'test' },
    metadata: {
      timestamp: new Date('2024-01-15T10:00:00Z'),
      correlationId: 'test-123',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    storage = new FileEventStorage('/test/events');
  });

  describe('constructor', () => {
    it('should create directory on initialization', () => {
      expect(mockFs.mkdirSync).toHaveBeenCalledWith('/test/events', { recursive: true });
    });
  });

  describe('persistOverflowEvent', () => {
    it('should persist event to overflow file', () => {
      mockFs.existsSync.mockReturnValue(false);

      storage.persistOverflowEvent(testEvent);

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('overflow-events.json'),
        expect.stringContaining('test.event'),
      );
    });

    it('should append to existing events', () => {
      const existingEvents = [
        { type: 'existing.event', payload: {}, metadata: { timestamp: '2024-01-01' } },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingEvents));

      storage.persistOverflowEvent(testEvent);

      const savedData = JSON.parse((mockFs.writeFileSync as jest.Mock).mock.calls[0][1]);
      expect(savedData).toHaveLength(2);
    });
  });

  describe('loadOverflowEvents', () => {
    it('should return empty array if file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const events = storage.loadOverflowEvents();

      expect(events).toEqual([]);
    });

    it('should load and return events from file', () => {
      const storedEvents = [
        { type: 'test.event', payload: {}, metadata: { timestamp: '2024-01-15T10:00:00Z' } },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(storedEvents));

      const events = storage.loadOverflowEvents();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('test.event');
    });

    it('should delete file after loading', () => {
      const storedEvents = [
        { type: 'test.event', payload: {}, metadata: { timestamp: '2024-01-15T10:00:00Z' } },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(storedEvents));

      storage.loadOverflowEvents();

      expect(mockFs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('overflow-events.json'));
    });

    it('should convert timestamp to Date', () => {
      const storedEvents = [
        { type: 'test.event', payload: {}, metadata: { timestamp: '2024-01-15T10:00:00Z' } },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(storedEvents));

      const events = storage.loadOverflowEvents();

      expect(events[0].metadata.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('persistDeadLetterEvent', () => {
    it('should persist event to dead letter file', () => {
      mockFs.existsSync.mockReturnValue(false);

      storage.persistDeadLetterEvent(testEvent);

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('dead-letter-events.json'),
        expect.stringContaining('test.event'),
      );
    });

    it('should append to existing dead letter events', () => {
      const existingEvents = [
        { type: 'existing.event', payload: {}, metadata: { timestamp: '2024-01-01' } },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingEvents));

      storage.persistDeadLetterEvent(testEvent);

      const savedData = JSON.parse((mockFs.writeFileSync as jest.Mock).mock.calls[0][1]);
      expect(savedData).toHaveLength(2);
    });
  });

  describe('loadDeadLetterEvents', () => {
    it('should return empty array if file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const events = storage.loadDeadLetterEvents();

      expect(events).toEqual([]);
    });

    it('should load and return dead letter events from file', () => {
      const storedEvents = [
        { type: 'failed.event', payload: {}, metadata: { timestamp: '2024-01-15T10:00:00Z' } },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(storedEvents));

      const events = storage.loadDeadLetterEvents();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('failed.event');
    });

    it('should delete file after loading', () => {
      const storedEvents = [
        { type: 'test.event', payload: {}, metadata: { timestamp: '2024-01-15T10:00:00Z' } },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(storedEvents));

      storage.loadDeadLetterEvents();

      expect(mockFs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('dead-letter-events.json'));
    });
  });
});
