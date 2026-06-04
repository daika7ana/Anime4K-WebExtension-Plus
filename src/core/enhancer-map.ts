import { VideoEnhancer } from './video-enhancer';

// Use a Map to store video elements and their corresponding enhancer instances
const enhancerMap = new Map<HTMLVideoElement, VideoEnhancer>();

/**
 * Associate an enhancer instance with a video element
 * @param video HTMLVideoElement - key
 * @param enhancer VideoEnhancer - value
 */
export function associateEnhancer(video: HTMLVideoElement, enhancer: VideoEnhancer): void {
  enhancerMap.set(video, enhancer);
}

/**
 * Get the enhancer instance associated with a video element
 * @param video HTMLVideoElement - key
 * @returns VideoEnhancer | undefined
 */
export function getEnhancer(video: HTMLVideoElement): VideoEnhancer | undefined {
  return enhancerMap.get(video);
}

/**
 * Check if a video element has an associated enhancer
 * @param video HTMLVideoElement - key
 * @returns boolean
 */
export function hasEnhancer(video: HTMLVideoElement): boolean {
  return enhancerMap.has(video);
}

/**
 * Dissociate a video element from its enhancer instance
 * @param video HTMLVideoElement - key
 */
export function dissociateEnhancer(video: HTMLVideoElement): void {
  enhancerMap.delete(video);
}

/**
 * Get all managed video elements
 * @returns HTMLVideoElement[]
 */
export function getAllManagedVideos(): HTMLVideoElement[] {
  return Array.from(enhancerMap.keys());
}