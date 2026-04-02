const axios = require('axios');
const Genius = require('genius-lyrics');
const config = require('../config');

class LyricsManager {
    constructor() {
        this.cache = new Map(); // Cache lyrics by track URL
        this.cacheTimers = new Map(); // Track cache expiration timers
        
        if (config.genius.accessToken !== undefined)
            this.geniusClient = new Genius.Client(config.genius.accessToken);
        else
            this.geniusClient = new Genius.Client(); // works via scraping
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
        if (!track || !track.title) {
            console.log('[Lyrics] ❌ No track or track.title provided');
            return null;
        }

        const cacheKey = this.getCacheKey(track);
        console.log(`[Lyrics] Fetching lyrics for: "${track.title}" by "${track.artist || track.uploader || 'unknown'}" (cacheKey: ${cacheKey})`);

        if (this.cache.has(cacheKey)) {
            console.log(`[Lyrics] ✅ Cache hit for: ${cacheKey}`);
            return this.cache.get(cacheKey);
        }

        // Try Genius first
        console.log('[Lyrics] Trying Genius...');
        const geniusResult = await this.fetchFromGenius(track);
        if (geniusResult && geniusResult.plain) {
            console.log(`[Lyrics] ✅ Genius returned lyrics (${geniusResult.plain.length} chars)`);
            this.storeInCache(cacheKey, geniusResult);
            return geniusResult;
        }
        console.log('[Lyrics] ⚠️ Genius returned no results');

        // Fallback to LRCLIB
        console.log('[Lyrics] Trying LRCLIB...');
        const lrclibResult = await this.fetchFromLrclib(track);
        if (lrclibResult && lrclibResult.plain) {
            console.log(`[Lyrics] ✅ LRCLIB returned lyrics (${lrclibResult.plain.length} chars)`);
            this.storeInCache(cacheKey, lrclibResult);
            return lrclibResult;
        }
        console.log('[Lyrics] ⚠️ LRCLIB returned no results');

        // Cache null result to avoid repeated lookups
        console.log('[Lyrics] ❌ No lyrics found from any source');
        this.storeInCache(cacheKey, null);
        return null;
    }





    async fetchFromLrclib(track) {
        try {
            const artist = track.artist || track.uploader || '';
            const searchUrl = 'https://lrclib.net/api/search';
            const cleanTitle = this.cleanTrackTitle(track.title || '');
            console.log(`[Lyrics/LRCLIB] Cleaned title: "${track.title}" -> "${cleanTitle}"`);

            const attempts = [];
            attempts.push({ track_name: cleanTitle, artist_name: artist });
            if (artist) {
                attempts.push({ track_name: cleanTitle });
            }
            if (cleanTitle && cleanTitle !== track.title) {
                attempts.push({ track_name: track.title, artist_name: artist });
            }
            console.log(`[Lyrics/LRCLIB] Will try ${attempts.length} search variations`);

            for (let i = 0; i < attempts.length; i++) {
                const params = attempts[i];
                if (!params.track_name) continue;

                try {
                    console.log(`[Lyrics/LRCLIB] Attempt ${i + 1}: searching with params:`, JSON.stringify(params));
                    const response = await axios.get(searchUrl, {
                        params,
                        timeout: 5000
                    });

                    console.log(`[Lyrics/LRCLIB] Response: ${response.data?.length || 0} results`);
                    if (response.data && response.data.length > 0) {
                        const result = response.data[0];
                        console.log(`[Lyrics/LRCLIB] First result: "${result.trackName}" by "${result.artistName}" (hasPlainLyrics: ${!!result.plainLyrics})`);
                        // Only use plain lyrics from LRCLIB
                        if (!result.plainLyrics) {
                            console.log('[Lyrics/LRCLIB] ⚠️ First result has no plainLyrics, trying next attempt');
                            continue;
                        }
                        
                        return this.buildLyricsData(track, {
                            plain: result.plainLyrics,
                            source: 'LRCLIB'
                        });
                    }
                } catch (error) {
                    console.error(`[Lyrics/LRCLIB] Attempt ${i + 1} failed:`, error.message, error.response?.status ? `(HTTP ${error.response.status})` : '');
                    if (i === attempts.length - 1) {
                        console.error('❌ Failed to fetch lyrics from LRCLIB:', error.message);
                    }
                }
            }

            console.log('[Lyrics/LRCLIB] ❌ All attempts exhausted, no lyrics found');
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
            console.log(`[Lyrics/Genius] Cleaned title: "${track.title}" -> "${title}", rawTitle: "${rawTitle}"`);
            
            if (!title) {
                console.log('[Lyrics/Genius] ❌ Title is empty after cleaning');
                return null;
            }

            // Extract romanized artist from title if main artist is non-Latin
            const romanizedFromTitle = (track.title || '').match(/\(([^)]*[A-Za-z][^)]*)\)/)?.[1]?.trim();
            if (romanizedFromTitle) {
                console.log(`[Lyrics/Genius] Extracted romanized from title: "${romanizedFromTitle}"`);
            }

            const queries = [];
            // 1. Cleaned title alone (often enough for well-known songs)
            if (title) queries.push(title);
            // 2. Cleaned artist + cleaned title
            if (artist && title) queries.push(`${artist} ${title}`);
            // 3. Romanized artist from title + cleaned title (critical for non-Latin artists)
            if (romanizedFromTitle && title) queries.push(`${romanizedFromTitle} ${title}`);
            // 4. Raw title with artist
            if (artist && rawTitle && rawTitle !== title) queries.push(`${artist} ${rawTitle}`);
            console.log(`[Lyrics/Genius] Will try ${queries.length} search queries:`, queries.map(q => `"${q}"`).join(', '));

            for (let i = 0; i < queries.length; i++) {
                const query = queries[i];
                if (!query) continue;
                try {
                    console.log(`[Lyrics/Genius] Query ${i + 1}: searching "${query}"`);
                    const searches = await this.geniusClient.songs.search(query);
                    console.log(`[Lyrics/Genius] Query ${i + 1}: ${searches?.length || 0} results`);
                    if (!searches || searches.length === 0) continue;

                    const firstSong = searches[0];
                    console.log(`[Lyrics/Genius] Query ${i + 1}: top result: "${firstSong.title}" by "${firstSong.artist?.name || 'unknown'}"`);
                    const lyrics = await firstSong.lyrics();
                    console.log(`[Lyrics/Genius] Query ${i + 1}: lyrics fetched, length: ${lyrics?.length || 0}`);
                    if (!lyrics) continue;

                    const cleanedLyrics = this.cleanGeniusLyrics(lyrics);
                    console.log(`[Lyrics/Genius] Query ${i + 1}: after cleaning, length: ${cleanedLyrics?.length || 0}`);
                    if (!cleanedLyrics) continue;

                    return this.buildLyricsData(track, {
                        plain: cleanedLyrics,
                        source: 'Genius'
                    });
                } catch (error) {
                    console.error(`[Lyrics/Genius] Query ${i + 1} failed:`, error.message);
                }
            }

            console.log('[Lyrics/Genius] ❌ All queries exhausted, no lyrics found');
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
