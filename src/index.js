// maunium-stickerpicker - A fast and simple Matrix sticker picker widget.
// Copyright (C) 2020 Tulir Asokan
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
import { html, render, Component } from "../lib/htm/preact.js"
import { Spinner } from "./spinner.js"
import * as widgetAPI from "./widget-api.js"
import * as frequent from "./frequently-used.js"

// The base URL for fetching packs. The app will first fetch ${PACK_BASE_URL}/index.json,
// then ${PACK_BASE_URL}/${packFile} for each packFile in the packs object of the index.json file.
const PACKS_BASE_URL = "packs"
// This is updated from packs/index.json
let HOMESERVER_URL = "https://matrix-client.matrix.org"

const makeThumbnailURL = mxc => `${HOMESERVER_URL}/_matrix/media/r0/thumbnail/${mxc.substr(6)}?height=64&width=64&method=scale`
const makeHqURL = mxc => `${HOMESERVER_URL}/_matrix/media/r0/thumbnail/${mxc.substr(6)}?height=256&width=256&method=scale`

// We need to detect iOS webkit because it has a bug related to scrolling non-fixed divs
// This is also used to fix scrolling to sections on Element iOS
const isMobileSafari = navigator.userAgent.match(/(iPod|iPhone|iPad)/) && navigator.userAgent.match(/AppleWebKit/)

export const parseQuery = str => Object.fromEntries(
	str.split("&")
		.map(part => part.split("="))
		.map(([key, value = ""]) => [key, value]))

const supportedThemes = ["light", "dark", "black"]

class App extends Component {
	constructor(props) {
		super(props)
		this.defaultTheme = parseQuery(location.search.substr(1)).theme
		this.state = {
			packs: [],
			loading: true,
			error: null,
			stickersPerRow: parseInt(localStorage.mauStickersPerRow || "4"),
			theme: localStorage.mauStickerThemeOverride || this.defaultTheme,
			frequentlyUsed: {
				id: "frequently-used",
				title: "Frequently used",
				stickerIDs: frequent.get(),
				stickers: [],
			},
			
			currentHoverID: null,
			lastHover: {
				url: "",
				id: "",
				body: "",
				hq: null
			},
			previewing: false
		}
		if (!supportedThemes.includes(this.state.theme)) {
			this.state.theme = "light"
		}
		if (!supportedThemes.includes(this.defaultTheme)) {
			this.defaultTheme = "light"
		}
		this.stickersByID = new Map(JSON.parse(localStorage.mauFrequentlyUsedStickerCache || "[]"))
		this.state.frequentlyUsed.stickers = this._getStickersByID(this.state.frequentlyUsed.stickerIDs)
		this.imageObserver = null
		this.packListRef = null
		this.navRef = null
		this.sendSticker = this.sendSticker.bind(this)
		this.navScroll = this.navScroll.bind(this)
		this.reloadPacks = this.reloadPacks.bind(this)
		
		this.mouseEnter = this.mouseEnter.bind(this)
		this.mouseLeave = this.mouseLeave.bind(this)
		
		this.observeSectionIntersections = this.observeSectionIntersections.bind(this)
		this.observeImageIntersections = this.observeImageIntersections.bind(this)
		
		this.scrollVelocity = 0.0
		
		setInterval(() => {
			if(this.navRef !== null){
				if(this.scrollVelocity > 0)
					this.navRef.scrollLeft += Math.floor(this.scrollVelocity)
				else
					this.navRef.scrollLeft += Math.ceil(this.scrollVelocity)
				this.scrollVelocity /= 1.25
			}
		}, 1000/60)
		
		
		this.hoverTimeout = null;
		
		
		let touchStartPos = {x: 0, y: 0};
		
		const mouseDown = (event) => {
			if(this.state.previewing) return;
			if(this.hoverTimeout !== null) return;
			this.hoverTimeout = setTimeout(() => {
				this.hoverTimeout = null;
				
				if(this.state.currentHoverID === null) return;
				this.setState({previewing: true});
			}, 500);
		};
		
		
		this.lastMouseUp = 0;
		
		const mouseUp = (event) => {
			if(this.hoverTimeout !== null) clearTimeout(this.hoverTimeout);
			this.hoverTimeout = null;
			
			if(this.state.previewing){
				this.lastMouseUp = (new Date()).getTime();
			}
			this.setState({previewing: false})
		}
		
		this.isMobile = (('ontouchstart' in window) ||
					 (navigator.maxTouchPoints > 0) ||
					 (navigator.msMaxTouchPoints > 0));
		
		document.ontouchstart = (evt) => {
			if(event.touches.length < 1) return;
			touchStartPos = {x: evt.touches[0].clientX, y: evt.touches[0].clientY};
			mouseDown(evt);
		};
		document.onmousedown = mouseDown;
		document.ontouchend = mouseUp;
		document.ontouchcancel = mouseUp;
		document.onmouseup = mouseUp;
		
		let last_touch = 0;
		let touch_move_timeout = null;
		document.ontouchmove = (event) => {
			if(event.touches.length < 1) return;
			
			if(!this.state.previewing && (this.hoverTimeout !== null)){
				let deltaX = touchStartPos.x - event.touches[0].clientX;
				let deltaY = touchStartPos.y - event.touches[0].clientY;
				
				let length_sq = (deltaX * deltaX) + (deltaY * deltaY);
				
				if(length_sq > 2*(event.touches[0].radiusX * event.touches[0].radiusX)) mouseUp();
			}
			
			let elem = document.elementFromPoint(event.touches[0].clientX, event.touches[0].clientY);
			
			let id = elem.getAttribute("data-sticker-id");
			if(id === null){
				elem = elem.parentNode;
				id = elem.getAttribute("data-sticker-id");
				if(id === null){
					// no sticker below
					this.setState({currentHoverID: null});
					return;
				}
			}
			
			
			this.mouseEnter({currentTarget: elem});
			
			last_touch = (new Date()).getTime();
			if(touch_move_timeout !== null) clearTimeout(touch_move_timeout);
			
			touch_move_timeout = setTimeout(() => {
				mouseUp();
			}, 5000);
		}
		
	}

	_getStickersByID(ids) {
		return ids.map(id => this.stickersByID.get(id)).filter(sticker => !!sticker)
	}

	updateFrequentlyUsed() {
		const stickerIDs = frequent.get()
		const stickers = this._getStickersByID(stickerIDs)
		this.setState({
			frequentlyUsed: {
				...this.state.frequentlyUsed,
				stickerIDs,
				stickers,
			},
		})
		localStorage.mauFrequentlyUsedStickerCache = JSON.stringify(stickers.map(sticker => [sticker.id, sticker]))
	}

	setStickersPerRow(val) {
		localStorage.mauStickersPerRow = val
		document.documentElement.style.setProperty("--stickers-per-row", localStorage.mauStickersPerRow)
		this.setState({
			stickersPerRow: val,
		})
		this.packListRef.scrollTop = this.packListRef.scrollHeight
	}

	setTheme(theme) {
		if (theme === "default") {
			delete localStorage.mauStickerThemeOverride
			this.setState({ theme: this.defaultTheme })
		} else {
			localStorage.mauStickerThemeOverride = theme
			this.setState({ theme: theme })
		}
	}

	reloadPacks() {
		this.imageObserver.disconnect()
		this.sectionObserver.disconnect()
		this.setState({ packs: [] })
		this._loadPacks(true)
	}

	_loadPacks(disableCache = false) {
		const cache = disableCache ? "no-cache" : undefined
		fetch(`${PACKS_BASE_URL}/index.json`, { cache }).then(async indexRes => {
			if (indexRes.status >= 400) {
				this.setState({
					loading: false,
					error: indexRes.status !== 404 ? indexRes.statusText : null,
				})
				return
			}
			const indexData = await indexRes.json()
			HOMESERVER_URL = indexData.homeserver_url || HOMESERVER_URL
			// TODO only load pack metadata when scrolled into view?
			for (const packFile of indexData.packs) {
				const packRes = await fetch(`${PACKS_BASE_URL}/${packFile}`, { cache })
				const packData = await packRes.json()
				for (const sticker of packData.stickers) {
					this.stickersByID.set(sticker.id, sticker)
				}
				this.setState({
					packs: [...this.state.packs, packData],
					loading: false,
				})
			}
			this.updateFrequentlyUsed()
		}, error => this.setState({ loading: false, error }))
	}

	componentDidMount() {
		document.documentElement.style.setProperty("--stickers-per-row", this.state.stickersPerRow.toString())
		this._loadPacks()
		this.imageObserver = new IntersectionObserver(this.observeImageIntersections, {
			rootMargin: "100px",
		})
		this.sectionObserver = new IntersectionObserver(this.observeSectionIntersections)
	}

	observeImageIntersections(intersections) {
		for (const entry of intersections) {
			const img = entry.target.children.item(0)
			if (entry.isIntersecting) {
				img.setAttribute("style", "background-image: url(" + img.getAttribute("data-src") + ")")
				img.classList.add("visible")
			} else {
				img.removeAttribute("style")
				img.classList.remove("visible")
			}
		}
	}

	observeSectionIntersections(intersections) {
		const navWidth = this.navRef.getBoundingClientRect().width
		let minX = 0, maxX = navWidth
		let minXElem = null
		let maxXElem = null
		for (const entry of intersections) {
			const packID = entry.target.getAttribute("data-pack-id")
			const navElement = document.getElementById(`nav-${packID}`)
			if (entry.isIntersecting) {
				navElement.classList.add("visible")
				const bb = navElement.getBoundingClientRect()
				if (bb.x < minX) {
					minX = bb.x
					minXElem = navElement
				} else if (bb.right > maxX) {
					maxX = bb.right
					maxXElem = navElement
				}
			} else {
				navElement.classList.remove("visible")
			}
		}
		if (minXElem !== null) {
			minXElem.scrollIntoView({ inline: "start" })
		} else if (maxXElem !== null) {
			maxXElem.scrollIntoView({ inline: "end" })
		}
	}

	componentDidUpdate() {
		if (this.packListRef === null) {
			return
		}
		for (const elem of this.packListRef.getElementsByClassName("sticker")) {
			this.imageObserver.observe(elem)
		}
		for (const elem of this.packListRef.children) {
			this.sectionObserver.observe(elem)
		}
	}

	componentWillUnmount() {
		this.imageObserver.disconnect()
		this.sectionObserver.disconnect()
	}
	
	mouseEnter(evt){
		const id = evt.currentTarget.getAttribute("data-sticker-id");
		const url = evt.currentTarget.getAttribute("url");
		const body = evt.currentTarget.getAttribute("alt");
		
		if(id == this.state.currentHoverID) return;
		
		this.setState({
			currentHoverID: id,
			lastHover: {
				id: id,
				url: url,
				body: body,
				hq: null
			}
		});
		
		var request = new Request(makeHqURL(url));
		
		fetch(request).then(response => response.blob()).then(blob => {
			var reader = new FileReader();
			var tmp = this;
			reader.onload = function(){
				if(tmp.state.lastHover.id !== id) return;
				
				tmp.setState({
					lastHover: {
						id: id,
						url: url,
						body: body,
						hq: this.result
					}
				});
			};
			
			reader.readAsDataURL(blob);
		});
	}
	
	mouseLeave(evt){
		const id = evt.currentTarget.getAttribute("data-sticker-id");
		
		if(this.state.currentHoverID === id){
			this.setState({currentHoverID: null});
		}
	}
	
	sendSticker(evt) {
		if(this.state.previewing) return;
		if(Math.abs(this.lastMouseUp - (new Date()).getTime()) < 60) return;
		const id = evt.currentTarget.getAttribute("data-sticker-id")
		const sticker = this.stickersByID.get(id)
		frequent.add(id)
		this.updateFrequentlyUsed()
		widgetAPI.sendSticker(sticker)
	}

	navScroll(evt) {
		this.scrollVelocity += evt.deltaY * 0.333
	}

	render() {
		const theme = `theme-${this.state.theme}`
		if (this.state.loading) {
			return html`<main class="spinner ${theme}"><${Spinner} size=${80} green /></main>`
		} else if (this.state.error) {
			return html`<main class="error ${theme}">
				<h1>Failed to load packs</h1>
				<p>${this.state.error}</p>
			</main>`
		} else if (this.state.packs.length === 0) {
			return html`<main class="empty ${theme}"><h1>No packs found 😿</h1></main>`
		}
		
		var overlayElement = ``
		if(this.state.lastHover !== null){
			var url = makeThumbnailURL(this.state.lastHover.url);
			if(this.state.lastHover.hq !== null) url = this.state.lastHover.hq
			overlayElement = html`
				<div class="overlay ${this.state.previewing ? "overlay-active" : ""}">
					<div class="sticker">
						<div class="visible" style="background-image: url(${url})">
							<div style="display: table; width: 100%; height: 100%;">
								<div style="display: table-cell; vertical-align: middle;" class="stickerbody">
									<div style="margin-top: max(-50vh, -50vw)">
									${this.state.lastHover.body}
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
			`
		}
		
		return html`<main class="has-content ${theme}">
			<nav>
				<${NavBarItem} pack=${this.state.frequentlyUsed} iconOverride="recent" />
				<nav onWheel=${this.navScroll} ref=${elem => this.navRef = elem}>
					${this.state.packs.map(pack => html`<${NavBarItem} id=${pack.id} pack=${pack}/>`)}
				</nav>
				<${NavBarItem} pack=${{ id: "settings", title: "Settings" }} iconOverride="settings" />
			</nav>
			<div class="pack-list ${isMobileSafari ? "ios-safari-hack" : ""} ${(this.isMobile && this.state.previewing) ? "noscroll" : ""}" ref=${elem => this.packListRef = elem}>
				<${Pack} pack=${this.state.frequentlyUsed} send=${this.sendSticker} enter=${this.mouseEnter} leave=${this.mouseLeave} />
				${this.state.packs.map(pack => html`<${Pack} id=${pack.id} pack=${pack} send=${this.sendSticker} enter=${this.mouseEnter} leave=${this.mouseLeave} />`)}
				<${Settings} app=${this}/>
			</div>
			
			${overlayElement}
		</main>`
	}
}

const Settings = ({ app }) => html`
	<section class="stickerpack settings" id="pack-settings" data-pack-id="settings">
		<h1>Settings</h1>
		<div class="settings-list">
			<button onClick=${app.reloadPacks}>Reload</button>
			<div>
				<label for="stickers-per-row">Stickers per row: ${app.state.stickersPerRow}</label>
				<input type="range" min=2 max=10 id="stickers-per-row" id="stickers-per-row"
					value=${app.state.stickersPerRow}
					onInput=${evt => app.setStickersPerRow(evt.target.value)} />
			</div>
			<div>
				<label for="theme">Theme: </label>
				<select name="theme" id="theme" onChange=${evt => app.setTheme(evt.target.value)}>
					<option value="default">Default</option>
					<option value="light">Light</option>
					<option value="dark">Dark</option>
					<option value="black">Black</option>
				</select>
			</div>
		</div>
	</section>
`

// By default we just let the browser handle scrolling to sections, but webviews on Element iOS
// open the link in the browser instead of just scrolling there, so we need to scroll manually:
const scrollToSection = (evt, id) => {
	const pack = document.getElementById(`pack-${id}`)
	pack.scrollIntoView({ block: "start", behavior: "instant" })
	evt.preventDefault()
}

const NavBarItem = ({ pack, iconOverride = null }) => html`
	<a href="#pack-${pack.id}" id="nav-${pack.id}" data-pack-id=${pack.id} title=${pack.title}
	   onClick=${isMobileSafari ? (evt => scrollToSection(evt, pack.id)) : undefined}>
		<div class="sticker">
			${iconOverride ? html`
				<span class="icon icon-${iconOverride}"/>
			` : html`
				<div style="background-image: url(${makeThumbnailURL(pack.stickers[0].url)});"
					alt=${pack.stickers[0].body} class="visible" />
			`}
		</div>
	</a>
`

const Pack = ({ pack, send, enter, leave }) => html`
	<section class="stickerpack" id="pack-${pack.id}" data-pack-id=${pack.id}>
		<h1>${pack.title}</h1>
		<div class="sticker-list">
			${pack.stickers.map(sticker => html`
				<${Sticker} key=${sticker.id} content=${sticker} send=${send} enter=${enter} leave=${leave}/>
			`)}
			
			${(pack.stickers.length === 0) ? "There are no items in this category :(" : null}
		</div>
	</section>
`

const Sticker = ({ content, send, enter, leave }) => html`
	<div class="sticker" onClick=${send} onmouseenter=${enter} onmouseleave=${leave} data-sticker-id=${content.id} alt=${content.body} url=${content.url}>
		<div data-src=${makeThumbnailURL(content.url)} alt=${content.body} title=${content.body} src="" />
	</div>
`

//		<img data-src=${makeThumbnailURL(content.url)} alt=${content.body} title=${content.body} />


render(html`<${App} />`, document.body)
