const axios = require('axios');
const Genius = require('genius-lyrics');
const config = require('../config');

class LyricsManager {
    constructor() {
        this.cache = new Map(); // Cache lyrics by track URL
        this.cacheTimers = new Map(); // Track cache expiration timers
        
        // Initialize Genius client (works without token via web scraping)
        // Token can be added later for higher rate limits: new Genius.Client(token)
        this.geniusClient = new Genius.Client();
    }



    getCacheKey(track) {
        if (!track) return 'unknown';
        const title = (track.title || '').toLowerCase();
        const artist = (track.artist || track.uploader || '').toLowerCase();
        return `${title}-${artist}` || title || 'unknown';
    }

    storeInCache(cacheKey, data, ttlMs = null) {
        if (!cacheKey) return;

        this.cache.set(cacheKey, data);

        if (this.cacheTimers.has(cacheKey)) {
            clearTimeout(this.cacheTimers.get(cacheKey));
        }

        const effectiveTtl = typeof ttlMs === 'number' ? ttlMs : (data ? 3600000 : 300000);

        const timer = setTimeout(() => {
            this.cache.delete(cacheKey);
            this.cacheTimers.delete(cacheKey);
        }, effectiveTtl);

        if (typeof timer.unref === 'function') {
            timer.unref();
        }

        this.cacheTimers.set(cacheKey, timer);
    }

    cleanTrackTitle(title = '') {
        let cleaned = title
            // Remove parentheses that contain only non-Latin characters (e.g. Korean/Chinese/Japanese)
            .replace(/\((?:[^\u0000-\u007F\u0080-\u024F\u1E00-\u1EFF])+?\)/g, '')
            // For mixed parentheses, strip non-Latin chars and keep the romanized part
            .replace(/\(([^)]*)\)/g, (_, inner) => {
                const latin = inner.replace(/[^\u0000-\u007F\u0080-\u024F\u1E00-\u1EFF\s'-]/g, '').trim();
                return latin ? `(${latin})` : '';
            })
            .replace(/\[.*?\]/g, '')
            .replace(/official\s+(video|audio|mv|music\s*video)/gi, '')
            .replace(/lyric\s*video/gi, '')
            .replace(/\blyrics\b/gi, '')
            .replace(/\b4k\b/gi, '')
            .replace(/\bhd\b/gi, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
        return cleaned;
    }

    /**
     * Build simple lyrics data object (no sync support)
     */
    buildLyricsData(track, data = {}) {
        return {
            plain: data.plain ?? null,
            source: data.source ?? null,
            artist: data.artist ?? track?.artist ?? track?.uploader ?? null,
            title: data.title ?? track?.title ?? null,
            album: data.album ?? null
        };
    }

    /**
     * Fetch lyrics - first from Genius, fallback to LRCLIB
     * @param {Object} track - Track object with title and artist
     * @returns {Promise<Object|null>} Lyrics object or null
     */
    async fetchLyrics(track) {
        if (!track || !track.title) return null;

        const cacheKey = this.getCacheKey(track);

        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        // Try Genius first
        const geniusResult = await this.fetchFromGenius(track);
        if (geniusResult && geniusResult.plain) {
            this.storeInCache(cacheKey, geniusResult);
            return geniusResult;
        }

        // Fallback to LRCLIB
        const lrclibResult = await this.fetchFromLrclib(track);
        if (lrclibResult && lrclibResult.plain) {
            this.storeInCache(cacheKey, lrclibResult);
            return lrclibResult;
        }

        // Cache null result to avoid repeated lookups
        this.storeInCache(cacheKey, null);
        return null;
    }





    async fetchFromLrclib(track) {
        try {
            const artist = track.artist || track.uploader || '';
            const searchUrl = 'https://lrclib.net/api/search';
            const cleanTitle = this.cleanTrackTitle(track.title || '');

            const attempts = [];
            attempts.push({ track_name: cleanTitle, artist_name: artist });
            if (artist) {
                attempts.push({ track_name: cleanTitle });
            }
            if (cleanTitle && cleanTitle !== track.title) {
                attempts.push({ track_name: track.title, artist_name: artist });
            }

            for (let i = 0; i < attempts.length; i++) {
                const params = attempts[i];
                if (!params.track_name) continue;

                try {
                    const response = await axios.get(searchUrl, {
                        params,
                        timeout: 5000
                    });

                    if (response.data && response.data.length > 0) {
                        const result = response.data[0];
                        // Only use plain lyrics from LRCLIB
                        if (!result.plainLyrics) continue;
                        
                        return this.buildLyricsData(track, {
                            plain: result.plainLyrics,
                            source: 'LRCLIB'
                        });
                    }
                } catch (error) {
                    if (i === attempts.length - 1) {
                        console.error('❌ Failed to fetch lyrics from LRCLIB:', error.message);
                    }
                }
            }

            return null;
        } catch (error) {
            console.error('❌ Failed to fetch lyrics from LRCLIB:', error.message);
            return null;
        }
    }

    async fetchFromGenius(track) {
        try {
            const artist = track.artist || track.uploader || '';
            const title = this.cleanTrackTitle(track.title || '');
            const rawTitle = (track.title || '').replace(/\[.*?\]/g, '').replace(/official\s+(video|audio|mv|music\s*video)/gi, '').replace(/lyric\s*video/gi, '').trim();
            
            if (!title) return null;

            // Extract romanized artist from title if main artist is non-Latin
            const romanizedFromTitle = (track.title || '').match(/\(([^)]*[A-Za-z][^)]*)\)/)?.[1]?.trim();

            const queries = [];
            // 1. Cleaned title alone (often enough for well-known songs)
            if (title) queries.push(title);
            // 2. Cleaned artist + cleaned title
            if (artist && title) queries.push(`${artist} ${title}`);
            // 3. Romanized artist from title + cleaned title (critical for non-Latin artists)
            if (romanizedFromTitle && title) queries.push(`${romanizedFromTitle} ${title}`);
            // 4. Raw title with artist
            if (artist && rawTitle && rawTitle !== title) queries.push(`${artist} ${rawTitle}`);

            for (const query of queries) {
                if (!query) continue;
                try {
                    const searches = await this.geniusClient.songs.search(query);
                    if (!searches || searches.length === 0) continue;

                    const firstSong = searches[0];
                    const lyrics = await firstSong.lyrics();
                    if (!lyrics) continue;

                    const cleanedLyrics = this.cleanGeniusLyrics(lyrics);
                    if (!cleanedLyrics) continue;

                    return this.buildLyricsData(track, {
                        plain: cleanedLyrics,
                        source: 'Genius'
                    });
                } catch (error) {
                    // Try next query
                }
            }

            return null;
        } catch (error) {
            console.error('❌ Failed to fetch lyrics from Genius:', error.message);
            return null;
        }
    }

    cleanGeniusLyrics(lyrics) {
        if (!lyrics) return null;

        let cleaned = lyrics;

        // Step 1: Remove contributor/translation header (everything before actual lyrics start)
        // Match: "131 Contributors...Lyrics" or "131 Contributors...Lyrics<img...>"
        cleaned = cleaned.replace(/^\d+\s+Contributors.*?Lyrics(<[^>]+>)*\s*/is, '');
        
        // Step 2: Remove HTML tags
        cleaned = cleaned.replace(/<[^>]*>/g, '');
        
        // Step 3: Remove description paragraphs (usually before [Verse] tags)
        // Match lines that end with "..." and "Read More"
        cleaned = cleaned.replace(/^[^\[]+?\.{3}\s*Read More\s*/im, '');
        
        // Step 4: Remove bracketed descriptions with quotes (like ["Susamam" ft. ...])
        cleaned = cleaned.replace(/\[[""][^\]]{50,}\]/g, '');
        
        // Step 5: Clean up whitespace
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        cleaned = cleaned.trim();

        return cleaned || null;
    }



    /**
     * Format full lyrics for display (with pagination support)
     * @param {Object} lyricsData - Lyrics data
     * @param {number} maxLength - Max character length per page
     * @returns {Array<string>} Array of lyric pages
     */
    formatFullLyrics(lyricsData, maxLength = 4000) {
        if (!lyricsData) return [];

        const text = lyricsData.plain || lyricsData.synced?.replace(/\[\d+:\d+\.\d+\]/g, '') || '';
        if (!text) return [];

        const pages = [];
        const lines = text.split('\n').filter(line => line.trim());

        let currentPage = '';
        for (const line of lines) {
            if ((currentPage + line + '\n').length > maxLength) {
                if (currentPage) pages.push(currentPage.trim());
                currentPage = line + '\n';
            } else {
                currentPage += line + '\n';
            }
        }
        
        if (currentPage) pages.push(currentPage.trim());

        return pages;
    }

    /**
     * Clear cache
     */
    clearCache() {
        this.cache.clear();
        for (const timer of this.cacheTimers.values()) {
            clearTimeout(timer);
        }
        this.cacheTimers.clear();
    }
}

module.exports = new LyricsManager();
