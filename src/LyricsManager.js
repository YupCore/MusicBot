const axios = require('axios');
const Genius = require('genius-lyrics');
const config = require('../config');

class LyricsManager {
    constructor() {
        this.cache = new Map();
        this.cacheTimers = new Map();

        if (config.genius?.accessToken)
            this.geniusClient = new Genius.Client(config.genius.accessToken);
        else
            this.geniusClient = new Genius.Client();
    }

    getCacheKey(track) {
        if (!track) return 'unknown';

        const title = (track.title || '').trim().toLowerCase();
        const artist = (track.artist || track.uploader || '').trim().toLowerCase();
        const combined = [title, artist].filter(Boolean).join('-');

        return combined || 'unknown';
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

    normalizeWhitespace(text = '') {
        return String(text)
            .replace(/[\u2010-\u2015]/g, '-')
            .replace(/[\u00A0\t\r\n]+/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    stripCommonNoise(text = '') {
        return this.normalizeWhitespace(
            String(text)
                .replace(/\[[^\]]*\]/g, ' ')
                .replace(/\b(?:official\s+)?(?:music\s+)?video\b/gi, ' ')
                .replace(/\bofficial\s+audio\b/gi, ' ')
                .replace(/\bofficial\s+mv\b/gi, ' ')
                .replace(/\blyric\s*video\b/gi, ' ')
                .replace(/\baudio\b/gi, ' ')
                .replace(/\blyrics\b/gi, ' ')
                .replace(/\bvisualizer\b/gi, ' ')
                .replace(/\b4k\b/gi, ' ')
                .replace(/\bhd\b/gi, ' ')
                .replace(/\s*\|\s*[^|]+$/g, ' ')
        );
    }

    cleanTrackTitle(title = '') {
        return this.stripCommonNoise(title);
    }

    normalizeForComparison(text = '') {
        return this.normalizeWhitespace(String(text))
            .normalize('NFKC')
            .toLowerCase()
            .replace(/["'`‘’“”]/g, '')
            .replace(/[()\[\]{}]/g, ' ')
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    tokenizeForComparison(text = '') {
        return this.normalizeForComparison(text)
            .split(' ')
            .filter(word => word && (word.length > 1 || /[^\x00-\x7F]/.test(word)));
    }

    removeEnclosingQuotes(text = '') {
        let value = this.normalizeWhitespace(text);

        while (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")) ||
            (value.startsWith('“') && value.endsWith('”')) ||
            (value.startsWith('‘') && value.endsWith('’'))
        ) {
            value = value.slice(1, -1).trim();
        }

        return value;
    }

    extractParentheticalContents(text = '') {
        const contents = [];
        const stack = [];

        for (const char of String(text)) {
            if (char === '(') {
                stack.push('');
                continue;
            }

            if (char === ')') {
                if (stack.length === 0) continue;

                const completed = stack.pop().trim();
                if (completed) contents.push(completed);

                if (stack.length > 0) {
                    stack[stack.length - 1] += `(${completed})`;
                }
                continue;
            }

            if (stack.length > 0) {
                stack[stack.length - 1] += char;
            }
        }

        return contents;
    }

    cleanArtistName(artist = '') {
        return this.normalizeWhitespace(
            String(artist)
                .replace(/\b(?:official|topic)\b/gi, ' ')
                .replace(/\s*-\s*topic$/i, ' ')
        );
    }

    splitArtistAndTitle(rawTitle = '') {
        const normalized = this.normalizeWhitespace(rawTitle);
        const separators = [' - ', ' – ', ' — ', ' —', ' –'];

        for (const separator of separators) {
            const index = normalized.indexOf(separator);
            if (index > 0 && index < normalized.length - separator.length) {
                return {
                    artistMeta: normalized.slice(0, index).trim(),
                    songTitle: normalized.slice(index + separator.length).trim()
                };
            }
        }

        return {
            artistMeta: '',
            songTitle: normalized
        };
    }

    addCandidate(target, value) {
        if (!value) return;

        const trimmed = this.normalizeWhitespace(value);
        const dequoted = this.removeEnclosingQuotes(trimmed);
        const preferred = dequoted.length && dequoted.length <= trimmed.length ? dequoted : trimmed;
        const key = this.normalizeForComparison(preferred);
        if (!preferred || !key) return;

        const existingIndex = target.findIndex(existing => this.normalizeForComparison(existing) === key);
        if (existingIndex === -1) {
            target.push(preferred);
            return;
        }

        if (preferred.length < target[existingIndex].length) {
            target[existingIndex] = preferred;
        }
    }

    stripFeatureSuffix(text = '') {
        return this.normalizeWhitespace(
            String(text).replace(/\s+(?:feat\.?|ft\.?|featuring|prod\.?|produced\s+by)\b.*$/i, '')
        );
    }

    extractCoreTitleVariants(title = '', artistHints = []) {
        const variants = [];
        const cleanedTitle = this.normalizeWhitespace(title);
        if (!cleanedTitle) return variants;

        this.addCandidate(variants, cleanedTitle);
        this.addCandidate(variants, this.removeEnclosingQuotes(cleanedTitle));
        this.addCandidate(variants, this.stripFeatureSuffix(this.removeEnclosingQuotes(cleanedTitle)));

        const splitBySlash = cleanedTitle.split(/\s+\/\s+/).map(part => this.normalizeWhitespace(part)).filter(Boolean);
        if (splitBySlash.length > 1) {
            const firstSegment = splitBySlash[0];
            const restCombined = splitBySlash.slice(1).join(' / ');
            const normalizedRest = this.normalizeForComparison(restCombined);
            const looksLikeMetadata =
                /\b(?:feat|ft|featuring|prod|produced|ost|op|ed|ver|version|remix|cover|self\s*cover|topic)\b/i.test(restCombined) ||
                artistHints.some(hint => {
                    const normalizedHint = this.normalizeForComparison(hint);
                    return normalizedHint && normalizedRest.includes(normalizedHint);
                });

            this.addCandidate(variants, firstSegment);

            if (looksLikeMetadata) {
                this.addCandidate(variants, this.stripFeatureSuffix(firstSegment));
            }
        }

        const parentheticalContents = this.extractParentheticalContents(cleanedTitle);
        for (const content of parentheticalContents) {
            const normalizedContent = this.normalizeWhitespace(content);
            if (!normalizedContent) continue;

            if (/^[A-Za-z0-9\s\-_.&/]+$/.test(normalizedContent)) {
                this.addCandidate(variants, normalizedContent);

                const parentheticalSlashParts = normalizedContent.split(/\s+\/\s+/).map(part => this.normalizeWhitespace(part)).filter(Boolean);
                if (parentheticalSlashParts.length > 1) {
                    this.addCandidate(variants, parentheticalSlashParts[0]);
                }
            }
        }

        return variants;
    }

    buildSearchMetadata(track) {
        const rawTitle = this.stripCommonNoise(track?.title || '');
        const cleanedArtist = this.cleanArtistName(track?.artist || track?.uploader || '');
        const split = this.splitArtistAndTitle(rawTitle);

        const artistCandidates = [];
        const titleCandidates = [];

        this.addCandidate(artistCandidates, cleanedArtist);
        this.addCandidate(artistCandidates, split.artistMeta);

        for (const part of this.extractParentheticalContents(split.artistMeta || rawTitle)) {
            const normalizedPart = this.normalizeForComparison(part);
            if (/[A-Za-z]/.test(part) && normalizedPart.replace(/\s+/g, '').length >= 2) {
                this.addCandidate(artistCandidates, part);
            }
        }

        const primaryTitle = split.songTitle || rawTitle;
        for (const variant of this.extractCoreTitleVariants(primaryTitle, artistCandidates)) {
            this.addCandidate(titleCandidates, variant);
        }

        if (!titleCandidates.length && rawTitle) {
            this.addCandidate(titleCandidates, rawTitle);
        }

        const romanizedTitleCandidates = titleCandidates.filter(candidate => /[A-Za-z]/.test(candidate));

        return {
            rawTitle,
            rawArtist: cleanedArtist,
            split,
            primaryTitle: titleCandidates[0] || rawTitle,
            titleCandidates,
            artistCandidates,
            romanizedTitleCandidates
        };
    }

    scoreMatchDetails(resultTitle = '', resultArtist = '', titleCandidates = [], artistCandidates = []) {
        const normalizedResultTitle = this.normalizeForComparison(resultTitle);
        const normalizedResultArtist = this.normalizeForComparison(resultArtist);

        let titleScore = 0;
        for (const candidate of titleCandidates) {
            const normalizedCandidate = this.normalizeForComparison(candidate);
            if (!normalizedCandidate) continue;

            if (normalizedCandidate === normalizedResultTitle) {
                titleScore = Math.max(titleScore, 120);
            } else if (normalizedResultTitle.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedResultTitle)) {
                titleScore = Math.max(titleScore, 90);
            } else {
                const candidateWords = this.tokenizeForComparison(normalizedCandidate);
                const resultWords = this.tokenizeForComparison(normalizedResultTitle);
                const overlap = candidateWords.filter(word => resultWords.includes(word)).length;
                if (overlap > 0) {
                    titleScore = Math.max(titleScore, Math.min(80, overlap * 20));
                }
            }
        }

        let artistScore = 0;
        for (const candidate of artistCandidates) {
            const normalizedCandidate = this.normalizeForComparison(candidate);
            if (!normalizedCandidate) continue;

            if (normalizedCandidate === normalizedResultArtist) {
                artistScore = Math.max(artistScore, 40);
            } else if (normalizedResultArtist.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedResultArtist)) {
                artistScore = Math.max(artistScore, 28);
            } else {
                const candidateWords = this.tokenizeForComparison(normalizedCandidate);
                const resultWords = this.tokenizeForComparison(normalizedResultArtist);
                const overlap = candidateWords.filter(word => resultWords.includes(word)).length;
                if (overlap > 0) {
                    artistScore = Math.max(artistScore, Math.min(24, overlap * 8));
                }
            }
        }

        return {
            titleScore,
            artistScore,
            total: titleScore + artistScore
        };
    }

    buildLyricsData(track, data = {}) {
        return {
            plain: data.plain ?? null,
            source: data.source ?? null,
            artist: data.artist ?? track?.artist ?? track?.uploader ?? null,
            title: data.title ?? track?.title ?? null,
            album: data.album ?? null
        };
    }

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

        console.log('[Lyrics] Trying Genius...');
        const geniusResult = await this.fetchFromGenius(track);
        if (geniusResult && geniusResult.plain) {
            console.log(`[Lyrics] ✅ Genius returned lyrics (${geniusResult.plain.length} chars)`);
            this.storeInCache(cacheKey, geniusResult);
            return geniusResult;
        }
        console.log('[Lyrics] ⚠️ Genius returned no results');

        console.log('[Lyrics] Trying LRCLIB...');
        const lrclibResult = await this.fetchFromLrclib(track);
        if (lrclibResult && lrclibResult.plain) {
            console.log(`[Lyrics] ✅ LRCLIB returned lyrics (${lrclibResult.plain.length} chars)`);
            this.storeInCache(cacheKey, lrclibResult);
            return lrclibResult;
        }
        console.log('[Lyrics] ⚠️ LRCLIB returned no results');

        console.log('[Lyrics] ❌ No lyrics found from any source');
        this.storeInCache(cacheKey, null);
        return null;
    }

    async fetchFromLrclib(track) {
        try {
            const metadata = this.buildSearchMetadata(track);
            const searchUrl = 'https://lrclib.net/api/search';

            console.log(`[Lyrics/LRCLIB] Parsed metadata: ${JSON.stringify({
                titleCandidates: metadata.titleCandidates,
                artistCandidates: metadata.artistCandidates
            })}`);

            const attempts = [];
            for (const titleCandidate of metadata.titleCandidates) {
                if (!titleCandidate) continue;

                for (const artistCandidate of metadata.artistCandidates) {
                    if (!artistCandidate) continue;
                    attempts.push({ track_name: titleCandidate, artist_name: artistCandidate });
                }

                attempts.push({ track_name: titleCandidate });
            }

            if (metadata.rawTitle && !attempts.some(attempt => this.normalizeForComparison(attempt.track_name) === this.normalizeForComparison(metadata.rawTitle))) {
                attempts.push({ track_name: metadata.rawTitle, artist_name: metadata.rawArtist || undefined });
            }

            const dedupedAttempts = [];
            const seen = new Set();
            for (const attempt of attempts) {
                const key = JSON.stringify({
                    track_name: this.normalizeForComparison(attempt.track_name),
                    artist_name: this.normalizeForComparison(attempt.artist_name || '')
                });

                if (seen.has(key)) continue;
                seen.add(key);
                dedupedAttempts.push(attempt);
            }

            console.log(`[Lyrics/LRCLIB] Will try ${dedupedAttempts.length} search variations`);

            for (let i = 0; i < dedupedAttempts.length; i++) {
                const params = dedupedAttempts[i];
                if (!params.track_name) continue;

                try {
                    console.log(`[Lyrics/LRCLIB] Attempt ${i + 1}: searching with params: ${JSON.stringify(params)}`);
                    const response = await axios.get(searchUrl, {
                        params,
                        timeout: 5000
                    });

                    const results = Array.isArray(response.data) ? response.data : [];
                    console.log(`[Lyrics/LRCLIB] Attempt ${i + 1}: ${results.length} results`);
                    if (!results.length) continue;

                    let bestResult = null;
                    let bestScore = -1;

                    for (const result of results.slice(0, 5)) {
                        const scoreDetails = this.scoreMatchDetails(
                            result.trackName,
                            result.artistName,
                            metadata.titleCandidates,
                            metadata.artistCandidates
                        );

                        console.log(`[Lyrics/LRCLIB] Candidate: "${result.trackName}" by "${result.artistName}" score=${scoreDetails.total} (title=${scoreDetails.titleScore}, artist=${scoreDetails.artistScore}) hasPlainLyrics=${!!result.plainLyrics}`);

                        if (metadata.artistCandidates.length > 0 && scoreDetails.artistScore === 0 && dedupedAttempts[i].artist_name) {
                            continue;
                        }

                        if (result.plainLyrics && scoreDetails.total > bestScore) {
                            bestResult = result;
                            bestScore = scoreDetails.total;
                        }
                    }

                    if (!bestResult) continue;

                    return this.buildLyricsData(track, {
                        plain: bestResult.plainLyrics,
                        source: 'LRCLIB',
                        artist: bestResult.artistName || track?.artist || track?.uploader || null,
                        title: bestResult.trackName || track?.title || null,
                        album: bestResult.albumName || null
                    });
                } catch (error) {
                    console.error(`[Lyrics/LRCLIB] Attempt ${i + 1} failed:`, error.message, error.response?.status ? `(HTTP ${error.response.status})` : '');
                    if (i === dedupedAttempts.length - 1) {
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
            const metadata = this.buildSearchMetadata(track);
            console.log(`[Lyrics/Genius] Parsed metadata: ${JSON.stringify({
                rawTitle: metadata.rawTitle,
                primaryTitle: metadata.primaryTitle,
                titleCandidates: metadata.titleCandidates,
                artistCandidates: metadata.artistCandidates
            })}`);

            if (!metadata.titleCandidates.length) {
                console.log('[Lyrics/Genius] ❌ Title is empty after normalization');
                return null;
            }

            const queries = [];
            for (const titleCandidate of metadata.titleCandidates) {
                for (const artistCandidate of metadata.artistCandidates) {
                    this.addCandidate(queries, `${artistCandidate} ${titleCandidate}`);
                }

                this.addCandidate(queries, titleCandidate);
            }

            for (const romanizedTitle of metadata.romanizedTitleCandidates) {
                for (const artistCandidate of metadata.artistCandidates) {
                    this.addCandidate(queries, `${artistCandidate} ${romanizedTitle}`);
                }

                this.addCandidate(queries, romanizedTitle);
            }

            if (metadata.rawTitle) {
                this.addCandidate(queries, metadata.rawTitle);
                if (metadata.rawArtist) {
                    this.addCandidate(queries, `${metadata.rawArtist} ${metadata.rawTitle}`);
                }
            }

            console.log(`[Lyrics/Genius] Will try ${queries.length} search queries: ${queries.map(q => `"${q}"`).join(', ')}`);

            const triedSongs = new Set();

            for (let i = 0; i < queries.length; i++) {
                const query = queries[i];
                if (!query) continue;

                try {
                    console.log(`[Lyrics/Genius] Query ${i + 1}: searching "${query}"`);
                    const searches = await this.geniusClient.songs.search(query);
                    const results = Array.isArray(searches) ? searches : [];
                    console.log(`[Lyrics/Genius] Query ${i + 1}: ${results.length} results`);
                    if (!results.length) continue;

                    let bestSong = null;
                    let bestScore = -1;

                    for (const song of results.slice(0, 5)) {
                        const songKey = String(song.id || `${song.title}-${song.artist?.name || ''}`);
                        if (triedSongs.has(songKey)) continue;

                        const scoreDetails = this.scoreMatchDetails(
                            song.title,
                            song.artist?.name || '',
                            metadata.titleCandidates,
                            metadata.artistCandidates
                        );

                        console.log(`[Lyrics/Genius] Query ${i + 1}: candidate "${song.title}" by "${song.artist?.name || 'unknown'}" score=${scoreDetails.total} (title=${scoreDetails.titleScore}, artist=${scoreDetails.artistScore})`);

                        const queryHasExplicitArtist = metadata.artistCandidates.some(candidate => {
                            const normalizedCandidate = this.normalizeForComparison(candidate);
                            return normalizedCandidate && this.normalizeForComparison(query).includes(normalizedCandidate);
                        });

                        if (metadata.artistCandidates.length > 0 && scoreDetails.artistScore === 0 && queryHasExplicitArtist) {
                            continue;
                        }

                        if (metadata.artistCandidates.length > 0 && scoreDetails.artistScore === 0 && !queryHasExplicitArtist && scoreDetails.total < 130) {
                            continue;
                        }

                        if (scoreDetails.total > bestScore) {
                            bestScore = scoreDetails.total;
                            bestSong = song;
                        }
                    }

                    if (!bestSong) continue;

                    const songKey = String(bestSong.id || `${bestSong.title}-${bestSong.artist?.name || ''}`);
                    triedSongs.add(songKey);

                    console.log(`[Lyrics/Genius] Query ${i + 1}: selected "${bestSong.title}" by "${bestSong.artist?.name || 'unknown'}" score=${bestScore}`);
                    const lyrics = await bestSong.lyrics();
                    console.log(`[Lyrics/Genius] Query ${i + 1}: lyrics fetched, length: ${lyrics?.length || 0}`);
                    if (!lyrics) continue;

                    const cleanedLyrics = this.cleanGeniusLyrics(lyrics);
                    console.log(`[Lyrics/Genius] Query ${i + 1}: after cleaning, length: ${cleanedLyrics?.length || 0}`);
                    if (!cleanedLyrics) continue;

                    return this.buildLyricsData(track, {
                        plain: cleanedLyrics,
                        source: 'Genius',
                        artist: bestSong.artist?.name || track?.artist || track?.uploader || null,
                        title: bestSong.title || track?.title || null
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

        cleaned = cleaned.replace(/^\d+\s+Contributors?.*?Lyrics(<[^>]+>)*\s*/is, '');
        cleaned = cleaned.replace(/<[^>]*>/g, '');
        cleaned = cleaned.replace(/^[^\[]+?\.{3}\s*Read More\s*/im, '');
        cleaned = cleaned.replace(/\["[^"]{50,}"\]/g, '');
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        cleaned = cleaned.trim();

        return cleaned || null;
    }

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

    clearCache() {
        this.cache.clear();
        for (const timer of this.cacheTimers.values()) {
            clearTimeout(timer);
        }
        this.cacheTimers.clear();
    }
}

module.exports = new LyricsManager();
