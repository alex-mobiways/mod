(function(){
    'use strict';

    // ===== Utils =====
    function startsWith(str, search){ return (str+'').lastIndexOf(search, 0) === 0; }
    function endsWith(str, search){ var s=(str+''); var i = s.length - (search+'').length; return i>=0 && s.indexOf(search, i) === i; }

    function baseUA(){
        return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
    }

    function fixLinkProtocol(url, prefer_http, replace_protocol){
        url = (url||'')+'';
        if(!url) return url;
        try{
            if(replace_protocol === true || replace_protocol === 'full'){
                if(prefer_http) url = url.replace(/^https:\/\//i,'http://');
                else url = url.replace(/^http:\/\//i,'https://');
            } else if(replace_protocol === 'auto'){
                if(location && location.protocol){
                    var p = location.protocol === 'https:' ? 'https://' : 'http://';
                    url = url.replace(/^https?:\/\//i, p);
                }
            }
        }catch(e){}
        return url;
    }

    function parseM3U(str){
        var out = [];
        try{
            var xinfo = null; var bw=0, w=0, h=0;
            (str||'').split('\n').forEach(function(line){
                line = (line||'').trim();
                if(!line) return;
                if(startsWith(line,'#')){
                    if(startsWith(line,'#EXT-X-STREAM-INF')){
                        xinfo = line;
                        var BW = line.match(/\bBANDWIDTH=(\d+)/); if(BW) bw = parseInt(BW[1]);
                        var RES = line.match(/\bRESOLUTION=(\d+)x(\d+)/); if(RES){ w=parseInt(RES[1]); h=parseInt(RES[2]); }
                    }
                } else {
                    out.push({ xstream: !!xinfo, bandwidth: bw, width: w, height: h, link: line });
                    xinfo = null; bw=0; w=0; h=0;
                }
            });
        }catch(e){}
        return out;
    }

    function decodePlayerJsHash(data){
        // PlayerJS encoded JSON in form "#..." base64-utf8 with trash markers sometimes
        if(!data || !startsWith(data,'#')) return data;
        var raw = data.slice(1);
        var dec = function(s){ try{ return decodeURIComponent(atob(s).split('').map(function(c){return '%' + ('00'+c.charCodeAt(0).toString(16)).slice(-2);}).join('')); }catch(e){ return ''; } };
        return dec(raw) || '';
    }

    function normalizeTitle(title){
        try{
            var t = (title||'')+'';
            // убрать год и страну из запроса
            t = t.replace(/\((19|20)\d{2}[^)]*\)/g, '');
            t = t.replace(/\b(19|20)\d{2}\b/g, '');
            t = t.replace(/\b(Исландия|США|Россия|Украина|Беларусь|Франция|Германия|Великобритания|Англия|Корея|Южная Корея|Северная Корея|Испания|Италия|Китай|Япония|Канада|Индия|Турция)\b/gi, '');
            t = t.replace(/\s{2,}/g, ' ').trim();
            return t;
        }catch(e){ return title; }
    }

    // Simple proxy chooser; can be extended in settings
    function proxy(name){
        // global toggles
        var other = Lampa.Storage.field('my_online_proxy_other') === true;
        var other_url = (Lampa.Storage.get('my_online_proxy_other_url','')+'').trim();
        var prefer_http = Lampa.Storage.field('my_online_prefer_http') === true;

        var builtin1 = (location && location.protocol === 'https:' ? 'https://' : 'http://') + 'prox.lampa.stream/';
        var builtin2 = (location && location.protocol === 'https:' ? 'https://' : 'http://') + 'cors.lampa.stream/';
        var picked = '';

        // per-source toggles
        var on = Lampa.Storage.field('my_online_proxy_'+name) === true;
        if(other && other_url){ picked = other_url; }
        else if(on){
            if(name === 'filmix') picked = builtin2;
            else picked = builtin1;
        }

        if(picked && picked.slice(-1) !== '/') picked += '/';
        return picked;
    }

    function proxyLink(url, name, extraEnc){
        url = (url||'')+'';
        var prox = proxy(name);
        if(!prox) return url;
        var enc = '';
        if(extraEnc && typeof extraEnc === 'object'){
            Object.keys(extraEnc).forEach(function(k){ enc += 'param/' + encodeURIComponent(k) + '=' + encodeURIComponent(extraEnc[k]) + '/'; });
        }
        return prox + (enc||'') + url;
    }

    // ===== Shared item render =====
    function ensureTemplates(){
        if(Lampa.Template.get('my_online_item',{},true)) return;
        Lampa.Template.add('my_online_item',
            "<div class=\"online selector\">\n"+
            "  <div class=\"online__body\">\n"+
            "    <div style=\"position:absolute;left:0;top:-0.3em;width:2.4em;height:2.4em\">\n"+
            "      <svg style=\"height:2.4em;width:2.4em\" viewBox=\"0 0 128 128\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n"+
            "        <circle cx=\"64\" cy=\"64\" r=\"56\" stroke=\"white\" stroke-width=\"16\"/>\n"+
            "        <path d=\"M90.5 64.3827L50 87.7654L50 41L90.5 64.3827Z\" fill=\"white\"/>\n"+
            "      </svg>\n"+
            "    </div>\n"+
            "    <div class=\"online__title\" style=\"padding-left:2.1em\">{title}</div>\n"+
            "    <div class=\"online__quality\" style=\"padding-left:3.4em\">{quality}{info}</div>\n"+
            "  </div>\n"+
            "</div>");
    }

    // ===== Providers (sources) =====

    // Collaps: api.namy.ws embed; parse makePlayer({...})
    function SourceCollaps(component, object){
        var network = new Lampa.Reguest();
        var prefer_http = Lampa.Storage.field('my_online_prefer_http') === true;
        var self = this; var extract = null; var select_title = '';
        var host = 'https://api.namy.ws';
        var embed = (prefer_http ? 'http:' : 'https:') + '//api.namy.ws/embed/';
        var encHeaders = {'User-Agent': baseUA(), 'Referer': host+'/', 'Origin': host};

        function getEmbed(api, cb, err){
            network.clear(); network.timeout(10000);
            var prox = proxy('collaps');
            var url = prox ? (prox + embed + api) : (embed + api);
            var hdrs = prox ? {} : encHeaders;
            network.native(url,
                function(html){ cb((html||'')+''); },
                function(a,c){ if(err) err(network.errorDecode(a,c)); }, false, {dataType:'text', headers: hdrs});
        }

        function parse(html){
            html = (html||'').replace(/\n/g,' ');
            var m = html.match(/makePlayer\((\{.*?\})\)/);
            var json = null;
            try{ json = m && (0,eval)('("use strict"; ('+m[1]+'))'); }catch(e){}
            if(json && json.playlist){ extract = json; build(); }
            else { if(self && self._noresults && self._noresults()) return; component.emptyForQuery(select_title); }
        }

        function build(){
            var items = [];
            try{
                if(extract.playlist && extract.playlist.seasons){
                    extract.playlist.seasons.forEach(function(season){
                        (season.episodes||[]).forEach(function(ep){
                            var link = ep.hls || ep.dash || '';
                            link = fixLinkProtocol(link, prefer_http, true);
                            items.push({
                                season: parseInt(season.season||1),
                                episode: parseInt(ep.episode||1),
                                title: component.formatEpisodeTitle(season.season||1, ep.episode||1, ep.title||''),
                                quality: '360p ~ 1080p',
                                info: '',
                                file: proxyLink(link, 'collaps'),
                                audio_tracks: (ep.audio && ep.audio.names||[]).map(function(n){ return {language:n}; }),
                                subtitles: (ep.cc||[]).map(function(c){return {label:c.name, url: proxyLink(fixLinkProtocol(c.url||'', prefer_http, true),'collaps')}})
                            });
                        });
                    });
                }
            }catch(e){}
            append(items);
        }

        function append(items){
            component.reset(); ensureTemplates();
            var viewed = Lampa.Storage.cache('online_view', 5000, []);
            var last = component.getLastEpisode(items);
            items.forEach(function(el){
                if(el.season){ el.translate_episode_end = last; }
                var item = Lampa.Template.get('my_online_item', el);
                var hash_file = Lampa.Utils.hash((el.season? [el.season, el.season>10?':':'', el.episode, object.movie.original_title].join('') : object.movie.original_title) + (el.title||''));
                var view = Lampa.Timeline.view(hash_file);
                el.timeline = view; item.append(Lampa.Timeline.render(view));
                item.on('hover:enter', function(){
                    if(!el.file) return Lampa.Noty.show(Lampa.Lang.translate('online_nolink'));
                    var first = { url: el.file, timeline: el.timeline, title: el.title, subtitles: el.subtitles, translate: {tracks: el.audio_tracks} };
                    Lampa.Player.play(first); Lampa.Player.playlist([first]);
                });
                component.append(item);
            });
            component.start(true);
        }

        this.search = function(_object, kinopoisk_id){
            object = _object; select_title = normalizeTitle(object.search || (object.movie && (object.movie.title || object.movie.name || object.movie.original_title || object.movie.original_name)) || '');
            var api = (+kinopoisk_id ? 'kp/' : 'imdb/') + kinopoisk_id;
            getEmbed(api, function(html){ if(html) parse(html); else if(self && self._noresults && self._noresults()){} else component.emptyForQuery(select_title); }, function(){ if(self && self._noresults && self._noresults()){} else component.emptyForQuery(select_title); });
        };

        this.filter = function(){ /* noop - only list */ };
        this.reset = function(){ component.reset(); this.search(object, object.movie.kinopoisk_id || object.movie.imdb_id || ''); };
        this._noresults = function(){ if(component && component.fallbackSearch) return component.fallbackSearch('collaps'); else return false; };
        this.destroy = function(){ network.clear(); extract = null; };
    }

    // CDNMovies: iframe -> Playerjs({file:"#..."})
    function SourceCDNMovies(component, object){
        var network = new Lampa.Reguest();
        var prefer_http = Lampa.Storage.field('my_online_prefer_http') === true;
        var self = this; var select_title=''; var extract=null;
        var EMBED = 'https://cdnmovies-stream.online/';

        function get(api, cb, err){
            network.clear(); network.timeout(10000);
            var url = proxyLink(EMBED + api, 'iframe');
            network.native(url, function(html){ cb((html||'')+''); }, function(a,c){ if(err) err(network.errorDecode(a,c)); }, false, {dataType:'text'});
        }

        function parse(html){
            html=(html||'').replace(/\n/g,' ');
            var m = html.match(/Playerjs\((\{.*?\})\);/);
            var cfg=null; try{ cfg = m && (0,eval)('("use strict"; (function(){ return '+m[1]+'; })())'); }catch(e){}
            if(!cfg || !cfg.file){ if(self && self._noresults && self._noresults()) return; component.emptyForQuery(select_title); return; }
            var file = decodePlayerJsHash(cfg.file);
            try{
                var data = JSON.parse(file);
                buildFromPlaylist(data);
            }catch(e){
                // maybe direct m3u8 or links
                buildFromLinks(cfg.file);
            }
        }

        function buildFromPlaylist(pl){
            var items=[]; try{
                (pl||[]).forEach(function(item){
                    var label=item.title||select_title;
                    var links = (item.file||'').split(' or ').map(function(u){ return u.trim(); }).filter(Boolean);
                    var link = links[0]||''; link = fixLinkProtocol(link, prefer_http, true);
                    items.push({ title: label, quality: '', info: '', file: proxyLink(link,'cdnmovies') });
                });
            }catch(e){}
            append(items);
        }

        function buildFromLinks(raw){
            var url = (raw||'').replace(/^#/,''); url = fixLinkProtocol(url, prefer_http, true);
            append([{ title: select_title, quality:'', info:'', file: proxyLink(url,'cdnmovies')}]);
        }

        function append(items){
            component.reset(); ensureTemplates();
            items.forEach(function(el){ var item = Lampa.Template.get('my_online_item', el); item.on('hover:enter', function(){ if(!el.file) return Lampa.Noty.show(Lampa.Lang.translate('online_nolink')); Lampa.Player.play({url:el.file, title:el.title}); Lampa.Player.playlist([{url:el.file, title:el.title}]); }); component.append(item); });
            component.start(true);
        }

        this.search = function(_object, kinopoisk_id){
            object = _object; select_title = object.search || (object.movie && (object.movie.title || object.movie.name || object.movie.original_title || object.movie.original_name)) || '';
            var api = (+kinopoisk_id ? 'kinopoisk/' : 'imdb/') + kinopoisk_id + '/iframe';
            get(api, function(html){ if(html) parse(html); else if(self && self._noresults && self._noresults()){} else component.emptyForQuery(select_title); }, function(){ if(self && self._noresults && self._noresults()){} else component.emptyForQuery(select_title); });
        };
        this.filter = function(){}; this.reset=function(){ component.reset(); this.search(object, object.movie.kinopoisk_id || object.movie.imdb_id || ''); }; this._noresults=function(){ if(component && component.fallbackSearch) return component.fallbackSearch('cdnmovies'); else return false; }; this.destroy=function(){ network.clear(); };
    }

    // HDRezka: requires mirror + (optionally) cookie for premium-only, basic extraction via ajax
    function SourceHDRezka(component, object){
        var network = new Lampa.Reguest();
        var prefer_http = Lampa.Storage.field('my_online_prefer_http') === true;
        var mirror = (Lampa.Storage.get('my_online_rezka_mirror','')+'').trim() || 'https://rezka.ag';
        var cookie = (Lampa.Storage.get('my_online_rezka_cookie','')+'').trim();
        var headers = Lampa.Platform.is('android') ? {'User-Agent': baseUA()} : {};
        if(cookie && Lampa.Platform.is('android')) headers['Cookie'] = cookie;
        var select_title=''; var extract=null; var alt_title=''; var sel_year=0;

        function searchPage(title, year, cb, err){
            var url = mirror + '/engine/ajax/search.php?query=' + encodeURIComponent(title);
            network.clear(); network.timeout(10000);
            network.native(proxyLink(url,'rezka'), function(resp){ cb(resp); }, function(a,c){ if(err) err(network.errorDecode(a,c)); }, false, {dataType:'text', headers: headers});
        }

        function pickLink(resp){
            var text = (resp||'')+'';
            // Некоторые зеркала отдают JSON с html внутри
            try{
                var trimmed = (text||'').trim();
                if(trimmed.charAt(0) === '{'){
                    var json = Lampa.Arrays && Lampa.Arrays.decodeJson ? Lampa.Arrays.decodeJson(trimmed,null) : null;
                    if(!json){ try{ json = JSON.parse(trimmed); }catch(e){} }
                    if(json && (json.result || json.html)) text = json.result || json.html || '';
                }
            }catch(e){}
            var blocks = (text||'').match(/<div class=\"b-content__inline_item-link\">[\s\S]*?<\/div>/g) || [];
            if(!blocks.length){
                // попробовать альтернативное название
                if(alt_title && alt_title !== select_title){
                    var t = alt_title; alt_title = ''; // чтобы не зациклиться
                    searchPage(t, sel_year, function(html){ pickLink(html); }, function(){ if(component && component.fallbackSearch && component.fallbackSearch('hdrezka')) return; component.emptyForQuery(select_title); });
                    return;
                }
                if(component && component.fallbackSearch && component.fallbackSearch('hdrezka')) return; component.emptyForQuery(select_title); return;
            }
            // naive: pick first
            var first = blocks[0];
            var href = (first.match(/href=\"([^\"]+)\"/)||[])[1] || '';
            if(!href){ if(component && component.fallbackSearch && component.fallbackSearch('hdrezka')) return; component.emptyForQuery(select_title); return; }
            getPage(href);
        }

        function getPage(url){
            network.clear(); network.timeout(10000);
            network.native(proxyLink(url,'rezka'), function(html){ parsePage((html||'')+'', url); }, function(a,c){ if(component && component.fallbackSearch && component.fallbackSearch('hdrezka')) return; component.emptyForQuery(select_title); }, false, {dataType:'text', headers: headers});
        }

        function parsePage(html, url){
            html = (html||'').replace(/\n/g,' ');
            // get ids
            var film_id = (html.match(/data-id=\"(\d+)\"/)||[])[1]||'';
            var is_series = /b-post__partcontent_main\s*\b.*?(Сезоны|Серии)/i.test(html) || /initCDNSeriesEvents/.test(html);
            var favs = (html.match(/data-favs=\"(\d+)\"/)||[])[1]||'0';
            var translators=[]; // collect translator ids
            var tlist = html.match(/translator_id\":(\d+)/g)||[];
            tlist.forEach(function(m){ var id = (m.match(/(\d+)/)||[])[1]; if(id && translators.indexOf(id)==-1) translators.push(id); });
            if(!translators.length){
                // fallback: parse .b-translators__item
                (html.match(/data-translation_id=\"(\d+)\"/g)||[]).forEach(function(m){ var id = (m.match(/(\d+)/)||[])[1]; if(id && translators.indexOf(id)==-1) translators.push(id); });
            }
            if(!film_id){ if(component && component.fallbackSearch && component.fallbackSearch('hdrezka')) return; component.emptyForQuery(select_title); return; }
            requestStreamList({film_id:film_id, is_series:is_series, favs:favs, translator_id: translators[0]});
        }

        function requestStreamList(ctx){
            var url = mirror + '/ajax/get_cdn_series/';
            var post = 'id=' + encodeURIComponent(ctx.film_id) + '&translator_id=' + encodeURIComponent(ctx.translator_id||'0') + '&season=1&episode=1&action=get_stream&favs=' + encodeURIComponent(ctx.favs||'0');
            if(!ctx.is_series){ url = mirror + '/ajax/get_cdn_movie/'; post = 'id=' + encodeURIComponent(ctx.film_id) + '&translator_id=' + encodeURIComponent(ctx.translator_id||'0') + '&action=get_movie&favs=' + encodeURIComponent(ctx.favs||'0'); }
            network.clear(); network.timeout(10000);
            network.native(proxyLink(url,'rezka'), function(json){
                var body = (typeof json === 'string') ? Lampa.Arrays.decodeJson(json,{}) : json;
                if(body && body.url){
                    var playlist = decodePlayerJsHash(body.url);
                    buildFromPlaylist(playlist);
                } else { if(component && component.fallbackSearch && component.fallbackSearch('hdrezka')) return; component.emptyForQuery(select_title); }
            }, function(a,c){ if(component && component.fallbackSearch && component.fallbackSearch('hdrezka')) return; component.emptyForQuery(select_title); }, post, {headers: headers});
        }

        function buildFromPlaylist(str){
            // expect JSON like PlayerJS playlist or HLS list separated with \n
            try{
                var list = JSON.parse(str); // [{title:'1080p', file:'...'}]
                var items = list.map(function(it){
                    var links = (it.file||'').split(' or ').filter(Boolean);
                    var link = fixLinkProtocol(links[0]||'', prefer_http, true);
                    return { title: it.title||select_title, quality: '', info:'', file: proxyLink(link,'rezka') };
                });
                append(items);
                return;
            }catch(e){}

            // fallback: parse m3u8 master
            var m3u = parseM3U(str);
            var items = m3u.filter(function(m){return !!m.link;}).map(function(m){
                var link = fixLinkProtocol(m.link, prefer_http, true);
                var q = m.height ? (m.height+'p') : '';
                return { title: select_title, quality: q, info:'', file: proxyLink(link,'rezka') };
            });
            append(items);
        }

        function append(items){
            component.reset(); ensureTemplates();
            if(!items || !items.length) return component.emptyForQuery(select_title);
            items.sort(function(a,b){ var qa=parseInt((a.quality||'').match(/(\d+)/)||0); var qb=parseInt((b.quality||'').match(/(\d+)/)||0); return qb-qa; });
            items.forEach(function(el){ var item = Lampa.Template.get('my_online_item', el); item.on('hover:enter', function(){ if(!el.file) return Lampa.Noty.show(Lampa.Lang.translate('online_nolink')); Lampa.Player.play({url: el.file, title: el.title}); Lampa.Player.playlist([{url:el.file,title:el.title}]); }); component.append(item); });
            component.start(true);
        }

        this.search = function(_object, kinopoisk_id){
            object=_object; select_title = normalizeTitle(object.search || (object.movie && (object.movie.title || object.movie.name || object.movie.original_title || object.movie.original_name)) || '');
            alt_title = normalizeTitle((object.movie && (object.movie.original_title || object.movie.original_name)) || '');
            var search_date = object.search_date || (object.movie && (object.movie.release_date || object.movie.first_air_date || object.movie.last_air_date)) || '0000';
            sel_year = parseInt((search_date+'').slice(0,4));
            searchPage(select_title, sel_year, function(html){ pickLink(html); }, function(){ component.emptyForQuery(select_title); });
        };
        this.filter=function(){}; this.reset=function(){ component.reset(); this.search(object, object.movie.kinopoisk_id || object.movie.imdb_id || ''); }; this.destroy=function(){ network.clear(); };
    }

    // Filmix (optional): token-based; minimal search -> list
    function SourceFilmix(component, object){
        var network = new Lampa.Reguest();
        var api = 'http://filmixapp.vip/api/v2/';
        var token = (Lampa.Storage.get('my_online_filmix_token','')+'').trim();
        var headers = Lampa.Platform.is('android') ? {'User-Agent':'okhttp/3.10.0'} : {};
        function devQuery(){ return 'app_lang=ru_RU&user_dev_apk=2.2.12&user_dev_id=' + Lampa.Utils.uid(16) + '&user_dev_name=MyOnline&user_dev_os=11&user_dev_vendor=Lampa&user_dev_token='+encodeURIComponent(token||''); }
        function url(p){ return api + p + (p.indexOf('?')>-1?'&':'?') + devQuery(); }

        this.search = function(_object){
            object=_object; var title = normalizeTitle(object.search || (object.movie && (object.movie.title || object.movie.name || object.movie.original_title || object.movie.original_name)) || ''); var prefer_http = Lampa.Storage.field('my_online_prefer_http') === true;
            if(!token){ component.empty(Lampa.Lang.translate('settings_cub_not_specified') + ' Filmix'); return; }
            network.clear(); network.timeout(10000);
            network.native(proxyLink(url('search?story='+encodeURIComponent(title)),'filmix'), function(json){
                var items=[]; try{ (json||[]).forEach(function(card){ var name = card.title || title; var link = (card.link_play || '').replace(/^#/,''); link = fixLinkProtocol(link, prefer_http, true); items.push({title:name, quality: (card.quality||'')+'', info:'', file: proxyLink(link,'filmix')}); }); }catch(e){}
                if(items.length) append(items); else component.emptyForQuery(title);
            }, function(a,c){ component.emptyForQuery(title); }, false, {headers: headers});
        };
        function append(items){ component.reset(); ensureTemplates(); items.forEach(function(el){ var item = Lampa.Template.get('my_online_item', el); item.on('hover:enter', function(){ Lampa.Player.play({url:el.file,title:el.title}); Lampa.Player.playlist([{url:el.file,title:el.title}]); }); component.append(item); }); component.start(true); }
        this.filter=function(){}; this.reset=function(){ this.search(object); }; this.destroy=function(){ network.clear(); };
    }

    // KinoPub (optional): requires device auth; here we only stub search by title if token exists
    function SourceKinoPub(component, object){
        var network = new Lampa.Reguest();
        var base = 'https://api.service-kp.com/';
        var token = (Lampa.Storage.get('my_online_kinopub_token','')+'').trim();
        this.search = function(_object){
            object=_object; var title = normalizeTitle(object.search || (object.movie && (object.movie.title || object.movie.name || object.movie.original_title || object.movie.original_name)) || '');
            if(!token){ component.empty(Lampa.Lang.translate('settings_cub_not_specified') + ' KinoPub'); return; }
            network.clear(); network.timeout(10000);
            var url = base + 'v1/items/search?query=' + encodeURIComponent(title) + '&access_token=' + encodeURIComponent(token);
            network.native(url, function(json){
                var items=[]; try{ (json && json.items || []).forEach(function(it){ if(it.playlist && it.playlist.hls){ items.push({title: it.title || title, quality:'', info:'', file: it.playlist.hls}); } }); }catch(e){}
                if(items.length) append(items); else component.emptyForQuery(title);
            }, function(a,c){ component.emptyForQuery(title); });
        };
        function append(items){ component.reset(); ensureTemplates(); items.forEach(function(el){ var item=Lampa.Template.get('my_online_item',el); item.on('hover:enter', function(){ Lampa.Player.play({url:el.file,title:el.title}); Lampa.Player.playlist([{url:el.file,title:el.title}]); }); component.append(item); }); component.start(true); }
        this.filter=function(){}; this.reset=function(){ this.search(object); }; this.destroy=function(){ network.clear(); };
    }

    // ===== Component =====
    function component(object){
        var network = new Lampa.Reguest();
        var scroll = new Lampa.Scroll({mask:true, over:true});
        var files = new Lampa.Explorer(object);
        var filter = new Lampa.Filter(object);
        var self = this;
        var sourceInstances = {};
        var sourcesOrder = [];
        var activeSource = '';
        var triedSources = {};
        var last;

        var prefer_http = Lampa.Storage.field('my_online_prefer_http') === true;

        var all_sources = [
            {name:'collaps', title:'Collaps', ctor: SourceCollaps, enabled:true},
            {name:'cdnmovies', title:'CDNMovies', ctor: SourceCDNMovies, enabled:true},
            {name:'hdrezka', title:'HDrezka', ctor: SourceHDRezka, enabled:true},
            {name:'filmix', title:'Filmix', ctor: SourceFilmix, enabled:!!(Lampa.Storage.get('my_online_filmix_token','')+'')},
            {name:'kinopub', title:'KinoPub', ctor: SourceKinoPub, enabled:!!(Lampa.Storage.get('my_online_kinopub_token','')+'')}
        ];

        var filter_sources = all_sources.filter(function(s){ return s.enabled; }).map(function(s){ return s.name; });
        if(!filter_sources.length) filter_sources = ['collaps'];
        sourcesOrder = filter_sources.slice();

        sourcesOrder.forEach(function(n){
            var meta = all_sources.filter(function(s){return s.name===n;})[0];
            if(meta){ sourceInstances[n] = new meta.ctor(self, object); }
        });

        function sourceMeta(name){ return all_sources.filter(function(s){return s.name===name;})[0] || {title:name}; }
        function updateSourceLabel(){
            try{
                var lab = filter.render().find('.filter--sort span');
                var meta = sourceMeta(activeSource);
                lab.text('Источник: ' + (meta.title||activeSource));
            }catch(e){}
        }

        this.fallbackSearch = function(from){
            try{ if(!from) from = activeSource; }catch(e){}
            triedSources[from] = true;
            // Предпочитаем HDRezka как универсальный по названию
            if(sourceInstances['hdrezka'] && !triedSources['hdrezka']){
                activeSource = 'hdrezka';
                updateSourceLabel();
                this.find();
                return true;
            }
            // Иначе пробуем следующий доступный неиспользованный источник
            for(var i=0;i<sourcesOrder.length;i++){
                var n = sourcesOrder[i];
                if(!triedSources[n] && sourceInstances[n]){
                    activeSource = n;
                    updateSourceLabel();
                    this.find();
                    return true;
                }
            }
            return false;
        };

        this.changeSource = function(name){
            if(name && sourceInstances[name]){
                activeSource = name;
                updateSourceLabel();
                this.search();
            }
        };

        this.create = function(){
            files.appendHead(filter.render());
            files.appendFiles(scroll.render());
            scroll.body().addClass('torrent-list');
            // Кнопка сортировки как переключатель источников (балансер)
            var sortBtn = filter.render().find('.filter--sort');
            sortBtn.find('span').text('Источник');
            sortBtn.off('hover:enter').on('hover:enter', function(){
                var items = sourcesOrder.map(function(n){
                    var m = all_sources.filter(function(s){return s.name===n;})[0] || {title:n};
                    return { title: m.title || n, source: n, selected: n===activeSource };
                });
                Lampa.Select.show({
                    title: 'Источник',
                    items: items,
                    onBack: function(){ Lampa.Controller.toggle('content'); },
                    onSelect: function(a){ self.changeSource(a.source); }
                });
            });
            updateSourceLabel();
            this.search();
            return this.render();
        };

        this.render = function(){ return files.render(); };
        this.reset = function(){
            try{ scroll.render().find('.empty').remove(); }catch(e){}
            if(typeof scroll.clear === 'function') scroll.clear();
            if(typeof scroll.reset === 'function') scroll.reset();
        };
        this.destroy = function(){ network.clear(); if(sourceInstances[activeSource] && sourceInstances[activeSource].destroy) sourceInstances[activeSource].destroy(); };

        this.search = function(){
            this.activity.loader(true);
            triedSources = {};
            this.filter({ source: filter_sources }, { source: 0 });
            this.reset();
            this.find();
        };

        this.find = function(){
            // Универсальный сбор ID и заголовка: разные сборки Lampa используют разные поля
            var m = object && object.movie ? object.movie : (object || {});
            var kp = m.kinopoisk_id || m.kinopoiskId || m.kp_id || m.kpId || m.kinopoisk_ID || m.kpid || m.id_kp || '';
            var imdb = m.imdb_id || m.imdbId || '';
            var query_id = kp || imdb || '';
            // Заголовок для фоллбека поиска
            object.search = object.search || m.title || m.name || m.original_title || m.original_name || '';

            // если нет ID — автоматически переключаемся на HDRezka (поиск по названию)
            if(!query_id && sourcesOrder.indexOf('hdrezka') !== -1){
                activeSource = 'hdrezka';
            }

            if(!activeSource) activeSource = sourcesOrder[0];
            var src = sourceInstances[activeSource];
            if(!src || !src.search){ this.emptyForQuery((object.movie && (object.movie.title||object.movie.name)) || object.search || ''); return; }
            src.search(object, query_id);
        };

        this.filter = function(items, choice){
            // не трогаем подпись активного источника
            filter.set('filter', items, choice);
        };

        this.append = function(item){ files.append(item); };
        this.start = function(){
            var self = this;
            Lampa.Controller.add('content', {
                toggle: function(){
                    Lampa.Controller.collectionSet(scroll.render(), files.render());
                    Lampa.Controller.collectionFocus(false, scroll.render());
                },
                up: function(){ if(Navigator.canmove('up')) Navigator.move('up'); else Lampa.Controller.toggle('head'); },
                down: function(){ Navigator.move('down'); },
                right: function(){ if (Navigator.canmove('right')) Navigator.move('right'); else filter.show('Источник','sort'); },
                left: function(){ if (Navigator.canmove('left')) Navigator.move('left'); else Lampa.Controller.toggle('menu'); },
                back: function(){ Lampa.Activity.backward(); }
            });
            Lampa.Controller.toggle('content');
            this.activity.loader(false);
        };
        this.empty = function (msg) {
            var empty = Lampa.Template.get('list_empty');
            if (msg) empty.find('.empty__descr').text(msg);
            scroll.append(empty);
            this.activity.loader(false);
        };
        this.emptyForQuery = function (query) {
            var text = '';
            try {
                text = Lampa.Lang.translate('online_mod_query_start') + ' (' + (query||'') + ') ' + Lampa.Lang.translate('online_mod_query_end');
            } catch(e) {
                text = (Lampa.Lang.translate('search_nofound')||'Ничего не найдено') + ': ' + (query||'');
            }
            this.empty(text);
        };

        this.formatEpisodeTitle = function(s,e,name){ var title=''; var full = Lampa.Storage.field('my_online_full_episode_title')===true; if(s!=null&&s!=='') title = (full?Lampa.Lang.translate('torrent_serial_season')+' ':'S')+s+' / '; if(!name||name==='') name = Lampa.Lang.translate('torrent_serial_episode')+' '+e; else if(e!=null&&e!=='') name = Lampa.Lang.translate('torrent_serial_episode')+' '+e+' - '+name; return title+name; };
        this.getLastEpisode = function(items){ var last=0; (items||[]).forEach(function(i){ if(i.episode && i.episode>last) last=i.episode; }); return last; };

        // hook filter select events
        filter.onSelect = function(type, a, b){
            if(type === 'filter'){
                if(a.stype === 'source'){
                    var srcName = filter_sources[b.index];
                    if(srcName && srcName!==activeSource){ self.reset(); activeSource = srcName; var src = sourceInstances[srcName]; try{ filter.render().find('.filter--sort span').text('Источник: ' + (sourceMeta(activeSource).title||activeSource)); }catch(e){} if(src && src.search) src.search(object, object.movie.kinopoisk_id || object.movie.imdb_id || ''); }
                }
            } else if(type === 'sort'){
                // not used
            }
        };
    }

    // ===== Bootstrap + Manifest =====
    function addSettings(){
        var t = '';
        t += "<div class=\"settings-param selector\" data-name=\"my_online_prefer_http\" data-type=\"toggle\"><div class=\"settings-param__name\">#{settings_rest_use_http}</div><div class=\"settings-param__value\"></div></div>";
        t += "<div class=\"settings-param selector\" data-name=\"my_online_full_episode_title\" data-type=\"toggle\"><div class=\"settings-param__name\">#{online_mod_full_episode_title}</div><div class=\"settings-param__value\"></div></div>";

        // Proxies
        t += "<div class=\"settings-param selector\" data-name=\"my_online_proxy_other\" data-type=\"toggle\"><div class=\"settings-param__name\">Proxy (custom)</div><div class=\"settings-param__value\"></div></div>";
        t += "<div class=\"settings-param selector\" data-name=\"my_online_proxy_other_url\" data-type=\"input\" placeholder=\"#{settings_cub_not_specified}\"><div class=\"settings-param__name\">Proxy URL</div><div class=\"settings-param__value\"></div></div>";
        t += "<div class=\"settings-param selector\" data-name=\"my_online_proxy_collaps\" data-type=\"toggle\"><div class=\"settings-param__name\">Proxy Collaps</div><div class=\"settings-param__value\"></div></div>";
        t += "<div class=\"settings-param selector\" data-name=\"my_online_proxy_cdnmovies\" data-type=\"toggle\"><div class=\"settings-param__name\">Proxy CDNMovies</div><div class=\"settings-param__value\"></div></div>";
        t += "<div class=\"settings-param selector\" data-name=\"my_online_proxy_iframe\" data-type=\"toggle\"><div class=\"settings-param__name\">Proxy Iframe (CDNMovies)</div><div class=\"settings-param__value\"></div></div>";
        t += "<div class=\"settings-param selector\" data-name=\"my_online_proxy_rezka\" data-type=\"toggle\"><div class=\"settings-param__name\">Proxy HDrezka</div><div class=\"settings-param__value\"></div></div>";
        t += "<div class=\"settings-param selector\" data-name=\"my_online_proxy_filmix\" data-type=\"toggle\"><div class=\"settings-param__name\">Proxy Filmix</div><div class=\"settings-param__value\"></div></div>";

        // Rezka
        t += "<div class=\"settings-param\" data-static=\"true\"><div class=\"settings-param__name\"><b>HDrezka</b></div></div>";
        t += "<div class=\"settings-param selector\" data-name=\"my_online_rezka_mirror\" data-type=\"input\" placeholder=\"https://rezka.ag\"><div class=\"settings-param__name\">Mirror</div><div class=\"settings-param__value\"></div></div>";
        t += "<div class=\"settings-param selector\" data-name=\"my_online_rezka_cookie\" data-type=\"input\" data-string=\"true\" placeholder=\"PHPSESSID=...; ...\"><div class=\"settings-param__name\">Cookie</div><div class=\"settings-param__value\"></div></div>";

        // Filmix
        t += "<div class=\"settings-param\" data-static=\"true\"><div class=\"settings-param__name\"><b>Filmix</b></div></div>";
        t += "<div class=\"settings-param selector\" data-name=\"my_online_filmix_token\" data-type=\"input\" data-string=\"true\" placeholder=\"#{settings_cub_not_specified}\"><div class=\"settings-param__name\">Filmix Token</div><div class=\"settings-param__value\"></div></div>";
        t += "<div class=\"settings-param selector\" data-name=\"my_online_filmix_add\" data-static=\"true\"><div class=\"settings-param__name\">#{filmix_params_add_device}</div><div class=\"settings-param__status\"></div></div>";

        // KinoPub
        t += "<div class=\"settings-param\" data-static=\"true\"><div class=\"settings-param__name\"><b>KinoPub</b></div></div>";
        t += "<div class=\"settings-param selector\" data-name=\"my_online_kinopub_token\" data-type=\"input\" data-string=\"true\" placeholder=\"#{settings_cub_not_specified}\"><div class=\"settings-param__name\">Access Token</div><div class=\"settings-param__value\"></div></div>";
        t += "<div class=\"settings-param selector\" data-name=\"my_online_kinopub_add\" data-static=\"true\"><div class=\"settings-param__name\">Добавить устройство (KinoPub)</div><div class=\"settings-param__status\"></div></div>";

        Lampa.Template.add('settings_my_online', '<div>'+t+'</div>');

        function injectFolder(){
            if(Lampa.Settings.main && Lampa.Settings.main() && !Lampa.Settings.main().render().find('[data-component="my_online"]').length){
                var field = $("<div class=\"settings-folder selector\" data-component=\"my_online\">\n  <div class=\"settings-folder__icon\">\n    <svg height=\"57\" viewBox=\"0 0 58 57\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M20 20.3735V45H26.8281V34.1262H36.724V26.9806H26.8281V24.3916C26.8281 21.5955 28.9062 19.835 31.1823 19.835H39V13H26.8281C23.6615 13 20 15.4854 20 20.3735Z\" fill=\"white\"/> <rect x=\"2\" y=\"2\" width=\"54\" height=\"53\" rx=\"5\" stroke=\"white\" stroke-width=\"4\"/></svg>\n  </div>\n  <div class=\"settings-folder__name\">My Online</div>\n</div>");
                Lampa.Settings.main().render().find('[data-component="more"]').after(field);
                Lampa.Settings.main().update();
            }
        }

        if(window.appready) injectFolder();
        else Lampa.Listener.follow('app', function(e){ if(e.type==='ready') injectFolder(); });

        Lampa.Settings.listener.follow('open', function(e){
            if(e.name === 'my_online'){
                // Filmix device add
                var filmixBtn = e.body.find('[data-name="my_online_filmix_add"]');
                filmixBtn.off('hover:enter').on('hover:enter', function(){
                    var status = filmixBtn.find('.settings-param__status').removeClass('active error wait').addClass('wait');
                    var user_code = ''; var user_token = '';
                    var devId = Lampa.Utils.uid(16);
                    var api = 'http://filmixapp.vip/api/v2/';
                    var devQuery = function(){ return 'app_lang=ru_RU&user_dev_apk=2.2.12&user_dev_id='+devId+'&user_dev_name=MyOnline&user_dev_os=11&user_dev_vendor=Lampa&user_dev_token='; };
                    var modal = $('<div><div class="broadcast__text">Подключение устройства Filmix</div><div class="broadcast__device selector" style="text-align:center">Ожидаем код...</div><br><div class="broadcast__scan"><div></div></div></div>');
                    Lampa.Modal.open({ title:'', html: modal, onBack: function(){ clearInterval(poll); Lampa.Modal.close(); Lampa.Controller.toggle('settings_component'); }, onSelect: function(){ Lampa.Utils.copyTextToClipboard(user_code, function(){ Lampa.Noty.show('Скопировано'); }); } });
                    var poll = setInterval(function(){
                        var url = api + 'user_profile?' + devQuery() + user_token;
                        var req = new Lampa.Reguest();
                        req.timeout(8000);
                        req.native(proxyLink(url,'filmix'), function(json){ if(json && json.user_data){ clearInterval(poll); Lampa.Modal.close(); Lampa.Storage.set('my_online_filmix_token', user_token); status.removeClass('wait error').addClass('active'); Lampa.Settings.update(); } });
                    }, 5000);
                    // request device code
                    var req = new Lampa.Reguest();
                    req.timeout(10000);
                    req.native(proxyLink(api + 'token_request?' + devQuery(),'filmix'), function(found){ if(found && found.status=='ok'){ user_token = found.code; user_code = found.user_code; modal.find('.selector').text(user_code); } else { status.removeClass('wait active').addClass('error'); } }, function(){ status.removeClass('wait active').addClass('error'); });
                });

                // KinoPub device add (OAuth2 device)
                var kpBtn = e.body.find('[data-name="my_online_kinopub_add"]');
                kpBtn.off('hover:enter').on('hover:enter', function(){
                    var status = kpBtn.find('.settings-param__status').removeClass('active error wait').addClass('wait');
                    var base = 'https://api.service-kp.com/';
                    var user_code = ''; var code = '';
                    var modal = $('<div><div class="broadcast__text">Подключение устройства KinoPub</div><div class="broadcast__device selector" style="background:#fff;color:#000;text-align:center">Ожидаем код...</div><br><div class="broadcast__scan"><div></div></div></div>');
                    Lampa.Modal.open({ title:'', html: modal, onBack:function(){ clearInterval(poll); Lampa.Modal.close(); Lampa.Controller.toggle('settings_component'); }, onSelect:function(){ Lampa.Utils.copyTextToClipboard(user_code, function(){ Lampa.Noty.show('Скопировано'); }); } });
                    var poll = setInterval(function(){
                        var req2 = new Lampa.Reguest(); req2.timeout(8000);
                        req2.native(base + 'oauth2/token', function(json){ if(json && json.access_token){ clearInterval(poll); Lampa.Modal.close(); Lampa.Storage.set('my_online_kinopub_token', json.access_token); status.removeClass('wait error').addClass('active'); Lampa.Settings.update(); } }, function(){}, false, { method:'POST', data: { 'grant_type':'device_token','client_id':'xbmc','client_secret':'cgg3gtifu46urtfp2zp1nqtba0k2ezxh','code': code } });
                    }, 5000);
                    var req = new Lampa.Reguest(); req.timeout(10000);
                    req.native(base + 'oauth2/device', function(json){ if(json && json.user_code){ user_code = json.user_code; code = json.code; modal.find('.selector').text(user_code); } else { status.removeClass('wait active').addClass('error'); } }, function(){ status.removeClass('wait active').addClass('error'); }, { 'grant_type':'device_code','client_id':'xbmc','client_secret':'cgg3gtifu46urtfp2zp1nqtba0k2ezxh' });
                });
            }
        });
    }

    function registerParams(){
        // Defaults
        Lampa.Params.trigger('my_online_prefer_http', false);
        Lampa.Params.trigger('my_online_full_episode_title', false);
        Lampa.Params.trigger('my_online_proxy_other', false);
        Lampa.Params.select('my_online_proxy_other_url', '', '');

        // per-source proxy toggles
        ['collaps','cdnmovies','rezka','filmix','iframe'].forEach(function(n){ Lampa.Params.trigger('my_online_proxy_'+n, false); });

        // sensible defaults for webOS/Tizen (жёсткий CORS) — включаем прокси по умолчанию
        if (Lampa.Platform && (Lampa.Platform.is('webos') || Lampa.Platform.is('tizen'))) {
            ['collaps','cdnmovies','rezka','iframe'].forEach(function(n){ Lampa.Params.trigger('my_online_proxy_'+n, true); });
        }

        Lampa.Params.select('my_online_rezka_mirror', '', '');
        Lampa.Params.select('my_online_rezka_cookie', '', '');
        Lampa.Params.select('my_online_filmix_token', '', '');
        Lampa.Params.select('my_online_kinopub_token', '', '');
    }

    function bootstrap(){
        Lampa.Component.add('my_online', component);
        var manifest = {
            type: 'video',
            version: '1.0.0',
            name: 'My Online',
            description: 'Онлайн: HDrezka + открытые источники (Collaps, CDNMovies) + Filmix/KinoPub (настройки).',
            component: 'my_online',
            onContextMenu: function(object){ return {name: Lampa.Lang.translate('online_watch'), description:''}; },
            onContextLauch: function(object){
                Lampa.Activity.push({url:'', title:'My Online', component:'my_online', search: object.title, search_one: object.title, search_two: object.original_title, movie: object, page:1});
            }
        };
        Lampa.Manifest.plugins = manifest;

        // Add button on full card
        var btn = "<div class=\"full-start__button selector view--my_online\" data-subtitle=\"My Online\">\n    <svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 244 260\" width=\"40\" height=\"40\"><path d=\"M242,88v170H10V88h41l-38,38h37.1l38-38h38.4l-38,38h38.4l38-38h38.3l-38,38H204L242,88L242,88z M228.9,2l8,37.7l0,0 L191.2,10L228.9,2z M160.6,56l-45.8-29.7l38-8.1l45.8,29.7L160.6,56z M84.5,72.1L38.8,42.4l38-8.1l45.8,29.7L84.5,72.1z M10,88 L2,50.2L47.8,80L10,88z\" fill=\"currentColor\"/></svg>\n    <span>My Online</span>\n</div>";
        Lampa.Listener.follow('full', function(e){
            if(e.type==='complite'){
                var b = $(Lampa.Lang.translate(btn));
                b.on('hover:enter', function(){
                    Lampa.Activity.push({
                        url:'', title:'My Online', component:'my_online',
                        search: e.data.movie.title, search_one: e.data.movie.title,
                        search_two: e.data.movie.original_title, movie: e.data.movie, page:1
                    });
                });
                var host = e.object.activity.render();
                // избегаем дубликатов
                if(host.find('.view--my_online').length){ return; }
                // вставляем ПЕРВОЙ кнопкой в известные контейнеры
                var placed = false;
                ['.full-start__buttons','.full-start-new__buttons','.full-start__buttons-left','.full-start__buttons-right'].some(function(sel){
                    var box = host.find(sel);
                    if(box && box.length){ box.prepend(b); placed = true; return true; }
                    return false;
                });
                if(!placed){
                    // запасной вариант: в начало общего блока
                    var fs = host.find('.full-start');
                    if(fs && fs.length) fs.prepend(b); else host.prepend(b);
                }
            }
        });

        registerParams();
        addSettings();
    }

    bootstrap();
})();
