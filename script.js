// ==UserScript==
// @name         Unedit and Undelete for Reddit
// @namespace    http://tampermonkey.net/
// @version      3.13.0
// @description  Creates the option next to edited and deleted Reddit comments/posts to show the original comment from before it was edited
// @author       Jonah Lawrence (DenverCoder1)
// @match        https://reddit.com/*
// @match        https://*.reddit.com/*
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/showdown@2.1.0/dist/showdown.min.js
// @license      MIT
// ==/UserScript==

/* jshint esversion: 8 */

(function () {
    "use strict";

    /**
     * Whether or not we are on old reddit and not redesign.
     * This will be set in the "load" event listener.
     * @type {boolean}
     */
    let isOldReddit = false;

    /**
     * Timeout to check for new edited comments on page.
     * This will be updated when scrolling.
     * @type {number?}
     */
    let scriptTimeout = null;

    /**
     * The element that is currently requesting content
     * @type {Element?}
     */
    let currentLoading = null;

    /**
     * List of submission ids of edited posts.
     * Used on Reddit redesign since the submissions are not marked as such.
     * This is set in the "load" event listener from the Reddit JSON API.
     * @type {Array<{id: string, edited: float}>}
     */
    let editedSubmissions = [];

    /**
     * The current URL that is being viewed.
     * On Redesign, this can change without the user leaving page,
     * so we want to look for new edited submissions if it changes.
     * @type {string}
     */
    let currentURL = window.location.href;

    /**
     * Showdown markdown converter
     * @type {showdown.Converter}
     */
    const mdConverter = new showdown.Converter({
        tables: true,
        simplifiedAutoLink: true,
        literalMidWordUnderscores: true,
        strikethrough: true,
        ghCodeBlocks: true,
        disableForced4SpacesIndentedSublists: true,
    });

    /**
     * Logging methods for displaying formatted logs in the console.
     *
     * logging.info("This is an info message");
     * logging.warn("This is a warning message");
     * logging.error("This is an error message");
     * logging.table({a: 1, b: 2, c: 3});
     */
    const logging = {
        INFO: "info",
        WARN: "warn",
        ERROR: "error",
        TABLE: "table",

        /**
         * Log a message to the console
         * @param {string} level The console method to use e.g. "log", "info", "warn", "error", "table"
         * @param {...string} messages - Any number of messages to log
         */
        _format_log(level, ...messages) {
            const logger = level in console ? console[level] : console.log;
            logger(`%c[unedit-for-reddit] %c[${level.toUpperCase()}]`, "color: #00b6b6", "color: #888800", ...messages);
        },

        /**
         * Log an info message to the console
         * @param {...string} messages - Any number of messages to log
         */
        info(...messages) {
            logging._format_log(this.INFO, ...messages);
        },

        /**
         * Log a warning message to the console
         * @param {...string} messages - Any number of messages to log
         */
        warn(...messages) {
            logging._format_log(this.WARN, ...messages);
        },

        /**
         * Log an error message to the console
         * @param {...string} messages - Any number of messages to log
         */
        error(...messages) {
            logging._format_log(this.ERROR, ...messages);
        },

        /**
         * Log a table to the console
         * @param {Object} data - The table to log
         */
        table(data) {
            logging._format_log(this.TABLE, data);
        },
    };

    /**
     * Find the ID of a comment or submission.
     * @param {Element} innerEl An element inside the comment.
     * @returns {string} The Reddit ID of the comment.
     */
    function getPostId(innerEl) {
        let postId = "";
        // redesign
        if (!isOldReddit) {
            const post = innerEl?.closest("[class*='t1_'], [class*='t3_']");
            postId = Array.from(post.classList).filter(function (el) {
                return el.indexOf("t1_") > -1 || el.indexOf("t3_") > -1;
            })[0];
        }
        // old reddit
        else {
            // old reddit comment
            postId = innerEl?.parentElement?.parentElement?.parentElement?.id.replace("thing_", "");
            // old reddit submission
            if (!postId && isInSubmission(innerEl)) {
                const match = window.location.href.match(/comments\/([A-Za-z0-9]{5,8})\//);
                postId = match ? match[1] : null;
                // submission in list view
                if (!postId) {
                    const thing = innerEl.closest(".thing");
                    postId = thing?.id.replace("thing_", "");
                }
            }
            // if still not found, check for the .reportform element
            if (!postId) {
                postId = innerEl.parentElement.parentElement
                    .getElementsByClassName("reportform")[0]
                    .className.replace(/.*t1/, "t1");
            }
        }
        return postId;
    }

    /**
     * Get the container of the comment or submission body for appending the original comment to.
     * @param {string} postId The ID of the comment or submission
     * @returns {Element} The container element of the comment or submission body.
     */
    function getPostBodyElement(postId) {
        let bodyEl = null,
            baseEl = null;
        // redesign
        if (!isOldReddit) {
            baseEl = document.querySelector(`#${postId}, .Comment.${postId}`);
            // in post preview popups, the id will appear again but in #overlayScrollContainer
            const popupEl = document.querySelector(`#overlayScrollContainer .Post.${postId}`);
            baseEl = popupEl ? popupEl : baseEl;
            if (baseEl) {
                if (baseEl.getElementsByClassName("RichTextJSON-root").length > 0) {
                    bodyEl = baseEl.getElementsByClassName("RichTextJSON-root")[0];
                } else if (isInSubmission(baseEl) && baseEl?.firstElementChild?.lastElementChild) {
                    const classicBodyEl = baseEl.querySelector(`div[data-adclicklocation="background"]`);
                    if (classicBodyEl) {
                        bodyEl = classicBodyEl;
                    } else {
                        bodyEl = baseEl.firstElementChild.lastElementChild;
                        if (bodyEl.childNodes.length === 1) {
                            bodyEl = bodyEl.firstElementChild;
                        }
                    }
                } else {
                    bodyEl = baseEl;
                }
            }
        }
        // old reddit
        else {
            // old reddit comments
            baseEl = document.querySelector(`form[id*='${postId}'] .md`);
            if (baseEl?.closest(".entry")) {
                bodyEl = baseEl;
            } else {
                baseEl = document.querySelector(".report-" + postId);
                bodyEl = baseEl ? baseEl.closest(".entry").querySelector(".usertext") : null;
            }
            // old reddit submissions
            if (!bodyEl) {
                bodyEl =
                    document.querySelector("div[data-url] .entry form .md") ||
                    document.querySelector("div[data-url] .entry form .usertext-body") ||
                    document.querySelector("div[data-url] .entry .top-matter");
            }
            // link view
            if (!bodyEl) {
                bodyEl = document.querySelector(`.id-${postId}`);
            }
        }
        return bodyEl;
    }

    /**
     * Check if surrounding elements imply element is in a selftext submission.
     * @param {Element} innerEl An element inside the post to check.
     * @returns {boolean} Whether or not the element is in a selftext submission
     */
    function isInSubmission(innerEl) {
        const selectors = [
            "a.thumbnail", // old reddit on profile page or list view
            "div[data-url]", // old reddit on submission page
            ".Post", // redesign
        ];
        return Boolean(innerEl.closest(selectors.join(", ")));
    }

    /**
     * Check if the element bounds are within the window bounds.
     * @param {Element} element The element to check
     * @returns {boolean} Whether or not the element is within the window
     */
    function isInViewport(element) {
        const rect = element.getBoundingClientRect();
        return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
            rect.right <= (window.innerWidth || document.documentElement.clientWidth)
        );
    }

    /**
     * Generate HTML from markdown for a comment or submission.
     * @param {string} postType The type of post - "comment" or "post" (submission)
     * @param {string} original The markdown to convert
     * @returns {string} The HTML of the markdown
     */
    function redditPostToHTML(postType, original) {
        // fix Reddit tables to have at least two dashes per cell in the alignment row
        let body = original.replace(/(?<=^\s*|\|\s*)(:?)-(:?)(?=\s*\|[-|\s:]*$)/gm, "$1--$2");
        // convert superscripts in the form "^(some text)" or "^text" to <sup>text</sup>
        const multiwordSuperscriptRegex = /\^\((.+?)\)/gm;
        while (multiwordSuperscriptRegex.test(body)) {
            body = body.replace(multiwordSuperscriptRegex, "<sup>$1</sup>");
        }
        const superscriptRegex = /\^(\S+)/gm;
        while (superscriptRegex.test(body)) {
            body = body.replace(superscriptRegex, "<sup>$1</sup>");
        }
        // convert user and subreddit mentions to links (can be /u/, /r/, u/, or r/)
        body = body.replace(/(?<=^|[^\w\/])(\/?)([ur]\/\w+)/gm, "[$1$2](/$2)");
        // add spaces after '>' to keep blockquotes (if it has '>!' ignore since that is spoilertext)
        body = body.replace(/^((?:&gt;|>)+)(?=[^!\s])/gm, function (match, p1) {
            return p1.replace(/&gt;/g, ">") + " ";
        });
        // convert markdown to HTML
        let html = mdConverter.makeHtml("\n\n### Original " + postType + ":\n\n" + body);
        // convert Reddit spoilertext
        html = html.replace(
            /(?<=^|\s|>)&gt;!(.+?)!&lt;(?=$|\s|<)/gm,
            "<span class='md-spoiler-text' title='Reveal spoiler'>$1</span>"
        );
        // replace &#x200B; with a zero-width space
        return html.replace(/&amp;#x200B;/g, "\u200B");
    }

    /**
     * Create a new paragraph containing the body of the original comment/post.
     * @param {Element} commentBodyElement The container element of the comment/post body.
     * @param {string} postType The type of post - "comment" or "post" (submission)
     * @param {object} postData The archived data of the original comment/post.
     * @param {Boolean} includeBody Whether or not to include the body of the original comment/post.
     */
    function showOriginalComment(commentBodyElement, postType, postData, includeBody) {
        const originalBody = typeof postData?.body === "string" ? postData.body : postData?.selftext;
        // create paragraph element
        const origBodyEl = document.createElement("p");
        origBodyEl.className = "og";
        // set text
        origBodyEl.innerHTML = includeBody ? redditPostToHTML(postType, originalBody) : "";
        // author and date details
        const detailsEl = document.createElement("div");
        detailsEl.style.fontSize = "12px";
        detailsEl.appendChild(document.createTextNode("Posted by "));
        const authorEl = document.createElement("a");
        authorEl.href = `/user/${postData.author}`;
        authorEl.innerText = postData.author;
        detailsEl.appendChild(authorEl);
        detailsEl.appendChild(document.createTextNode(" · "));
        const dateEl = document.createElement("a");
        dateEl.href = postData.permalink;
        dateEl.title = new Date(postData.created_utc * 1000).toString();
        dateEl.innerText = getRelativeTime(postData.created_utc);
        detailsEl.appendChild(dateEl);
        // append horizontal rule if the original body is shown
        if (includeBody) {
            origBodyEl.appendChild(document.createElement("hr"));
        }
        // append to original comment
        origBodyEl.appendChild(detailsEl);
        const existingOg = commentBodyElement.querySelector(".og");
        if (existingOg && includeBody) {
            // if there is an existing paragraph and this element contains the body, replace it
            existingOg.replaceWith(origBodyEl);
        } else if (!existingOg) {
            // if there is no existing paragraph, append it
            commentBodyElement.appendChild(origBodyEl);
        }
        // scroll into view
        setTimeout(function () {
            if (!isInViewport(origBodyEl)) {
                origBodyEl.scrollIntoView({ behavior: "smooth" });
            }
        }, 500);
        // Redesign
        if (!isOldReddit) {
            // Make sure collapsed submission previews are expanded to not hide the original comment.
            commentBodyElement.parentElement.style.maxHeight = "unset";
        }
        // Old reddit
        else {
            // If the comment is collapsed, expand it so the original comment is visible
            expandComment(commentBodyElement);
        }
    }

    /**
     * Expand comment if it is collapsed (on old reddit only).
     * @param {Element} innerEl An element inside the comment.
     */
    function expandComment(innerEl) {
        const collapsedComment = innerEl.closest(".collapsed");
        if (collapsedComment) {
            collapsedComment.classList.remove("collapsed");
            collapsedComment.classList.add("noncollapsed");
        }
    }

    /**
     * Create a link to view the original comment/post.
     * @param {Element} innerEl An element inside the comment or post to create a link for.
     */
    function createLink(innerEl) {
        // if there is already a link, don't create another unless the other was a show author link
        if (innerEl.parentElement.querySelector("a.showOriginal:not(.showAuthorOnly)")) {
            return;
        }
        // create link to "Show orginal" or "Show author"
        const showAuthor = innerEl.classList.contains("showAuthorOnly");
        const showLinkEl = document.createElement("a");
        showLinkEl.innerText = showAuthor ? "Show author" : "Show original";
        showLinkEl.className = innerEl.className + " showOriginal";
        showLinkEl.style.textDecoration = "underline";
        showLinkEl.style.cursor = "pointer";
        showLinkEl.style.marginLeft = "6px";
        innerEl.parentElement.appendChild(showLinkEl);
        innerEl.classList.add("match");
        // find id of selected comment or submission
        const postId = getPostId(showLinkEl);
        showLinkEl.alt = `View original post for ID ${postId}`;
        if (!postId) {
            showLinkEl.style.color = "#dd2c00";
        }
        // click event
        showLinkEl.addEventListener(
            "click",
            async function () {
                // allow only 1 request at a time
                if (typeof currentLoading != "undefined" && currentLoading !== null) {
                    return;
                }
                // create url for getting comment/post from pushshift api
                const idURL = isInSubmission(this)
                    ? "https://api.pushshift.io/reddit/search/submission/?ids=" +
                      postId +
                      "&sort=desc&sort_type=created_utc&fields=selftext,author,id,created_utc,permalink"
                    : "https://api.pushshift.io/reddit/search/comment/?ids=" +
                      postId +
                      "&sort=desc&sort_type=created_utc&fields=body,author,id,link_id,created_utc,permalink";
                // create url for getting author comments/posts from pushshift api
                const author = this.parentElement.querySelector("a[href*=user]")?.innerText;
                const authorURL = isInSubmission(this)
                    ? "https://api.pushshift.io/reddit/search/submission/?author=" +
                      author +
                      "&size=200&sort=desc&sort_type=created_utc&fields=selftext,author,id,created_utc,permalink"
                    : "https://api.pushshift.io/reddit/search/comment/?author=" +
                      author +
                      "&size=200&sort=desc&sort_type=created_utc&fields=body,author,id,link_id,created_utc,permalink";

                // set loading status
                currentLoading = this;
                this.innerHTML = "loading...";

                logging.info("Fetching from " + idURL + " and " + authorURL);

                // request from pushshift api
                await Promise.all([
                    fetch(idURL)
                        .then((resp) => resp.json())
                        .catch((error) => {
                            logging.error("Error:", error);
                        }),
                    fetch(authorURL)
                        .then((resp) => resp.json())
                        .catch((error) => {
                            logging.error("Error:", error);
                        }),
                ])
                    .then((responses) => {
                        responses.forEach((out) => {
                            // locate the comment that was being loaded
                            const loading = currentLoading;
                            // exit if already found
                            if (loading.innerHTML === "") {
                                return;
                            }
                            // locate comment body
                            const commentBodyElement = getPostBodyElement(postId);
                            const post = out?.data?.find((p) => p?.id === postId?.split("_").pop());
                            logging.info("Response:", { author, id: postId, post, data: out?.data });
                            const includeBody = !loading.classList.contains("showAuthorOnly");
                            // check that comment was fetched and body element exists
                            if (!commentBodyElement) {
                                // the comment body element was not found
                                loading.innerHTML = "body element not found";
                                logging.error("Body element not found:", out);
                            } else if (typeof post?.body === "string") {
                                // create new paragraph containing the body of the original comment
                                showOriginalComment(commentBodyElement, "comment", post, includeBody);
                                // remove loading status from comment
                                loading.innerHTML = "";
                                logging.info("Successfully loaded comment.");
                            } else if (typeof post?.selftext === "string") {
                                // check if result has selftext instead of body (it is a submission post)
                                // create new paragraph containing the selftext of the original submission
                                showOriginalComment(commentBodyElement, "post", post, includeBody);
                                // remove loading status from post
                                loading.innerHTML = "";
                                logging.info("Successfully loaded post.");
                            } else if (out?.data?.length === 0) {
                                // data was returned empty
                                loading.innerHTML = "not found";
                                logging.warn("No results:", out);
                            } else if (out?.data?.length > 0) {
                                // no matching comment/post was found in the data
                                loading.innerHTML = "not found";
                                logging.warn("No matching post:", out);
                            } else {
                                // other issue occurred with displaying comment
                                loading.innerHTML = "fetch failed";
                                logging.error("Fetch failed:", out);
                            }
                        });
                    })
                    .catch(function (err) {
                        throw err;
                    });

                // reset status
                currentLoading = null;
            },
            false
        );
    }

    /**
     * Convert unix timestamp in seconds to a relative time string (e.g. "2 hours ago").
     * @param {number} timestamp A unix timestamp in seconds.
     * @returns {string} A relative time string.
     */
    function getRelativeTime(timestamp) {
        const time = new Date(timestamp * 1000);
        const now = new Date();
        const seconds = Math.round((now.getTime() - time.getTime()) / 1000);
        const minutes = Math.round(seconds / 60);
        const hours = Math.round(minutes / 60);
        const days = Math.round(hours / 24);
        const months = Math.round(days / 30.5);
        const years = Math.round(days / 365);
        if (years > 0 && months >= 12) {
            return `${years} ${years === 1 ? "year" : "years"} ago`;
        }
        if (months > 0 && days >= 30) {
            return `${months} ${months === 1 ? "month" : "months"} ago`;
        }
        if (days > 0 && hours >= 24) {
            return `${days} ${days === 1 ? "day" : "days"} ago`;
        }
        if (hours > 0 && minutes >= 60) {
            return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
        }
        if (minutes > 0 && seconds >= 60) {
            return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
        }
        return "just now";
    }

    /**
     * Locate comments and add links to each.
     */
    function findEditedComments() {
        // when function runs, cancel timeout
        if (scriptTimeout) {
            scriptTimeout = null;
        }
        // list elements to check for edited or deleted status
        let selectors = [],
            elementsToCheck = [],
            editedComments = [];
        // redesign
        if (!isOldReddit) {
            // check for edited/deleted comments and deleted submissions
            selectors = [
                ".Comment div:first-of-type span:not(.found)", // Comments "edited..." or "Comment deleted/removed..."
                ".Post div div div:last-of-type div ~ div:last-of-type:not(.found)", // Submissions "It doesn't appear in any feeds..." message
            ];
            elementsToCheck = Array.from(document.querySelectorAll(selectors.join(", ")));
            editedComments = elementsToCheck.filter(function (el) {
                el.classList.add("found");
                // we only care about the element if it has no children
                if (el.children.length) {
                    return false;
                }
                const isEditedOrRemoved =
                    el.innerText.substring(0, 6) === "edited" || // include edited comments
                    el.innerText.substring(0, 15) === "Comment deleted" || // include comments deleted by user
                    el.innerText.substring(0, 15) === "Comment removed" || // include comments removed by moderator
                    el.innerText.substring(0, 30) === "It doesn't appear in any feeds" || // include deleted submissions
                    el.innerText.substring(0, 23) === "Moderators remove posts"; // include submissions removed by moderators
                const isDeletedAuthor = el.innerText === "[deleted]"; // include comments from deleted users
                // if the element has a deleted author, make a link to only show the deleted author
                if (isDeletedAuthor) {
                    el.classList.add("showAuthorOnly");
                }
                // keep element if it is edited or removed or if it has a deleted author
                return isEditedOrRemoved || isDeletedAuthor;
            });
            // Edited submissions found using the Reddit API
            editedSubmissions.forEach((submission) => {
                let found = false;
                const postId = submission.id;
                const editedAt = submission.edited;
                const deletedAuthor = submission.deletedAuthor;
                const deletedPost = submission.deletedPost;
                selectors = [
                    `#t3_${postId} > div:first-of-type > div:nth-of-type(2) > div:first-of-type > div:first-of-type > span:first-of-type:not(.found)`, // Submission page
                    `#t3_${postId} > div:first-of-type > div:nth-of-type(2) > div:first-of-type > div:first-of-type > div:first-of-type > div:first-of-type > span:first-of-type:not(.found)`, // Comment context page
                    `#t3_${postId} > div:last-of-type[data-click-id] > div:first-of-type > div:first-of-type > div:first-of-type:not(.found)`, // Subreddit listing view
                    `.Post.t3_${postId} > div:last-of-type[data-click-id] > div:first-of-type > div:nth-of-type(2) > div:not([data-adclicklocation]):first-of-type:not(.found)`, // Profile/home/classic listing view
                    `.Post.t3_${postId} > div:first-of-type > div[data-click-id="background"] > div:first-of-type > div[data-click-id="body"] > div[data-adclicklocation="top_bar"]:not(.found)`, // Compact listing view
                    `.Post.t3_${postId} > div:last-of-type[data-click-id] > div:first-of-type > div:nth-of-type(2) div[data-adclicklocation="top_bar"]:not(.found)`, // Profile/home listing view
                    `.Post.t3_${postId}:not(.scrollerItem) > div:first-of-type > div:nth-of-type(2) > div:nth-of-type(2) > div:first-of-type > div:first-of-type:not(.found)`, // Preview popup
                ];
                Array.from(document.querySelectorAll(selectors.join(", "))).forEach((el) => {
                    // add found class so that it won't be checked again in the future
                    el.classList.add("found");
                    // if this is the first time we've found this post, add it to the list of posts to add the link to
                    if (!found) {
                        found = true;
                        editedComments.push(el);
                        if (editedAt) {
                            if (!el.parentElement.querySelector(".edited-date")) {
                                // display when the post was edited
                                const editedDateElement = document.createElement("span");
                                editedDateElement.classList.add("edited-date");
                                editedDateElement.style.fontStyle = "italic";
                                editedDateElement.innerText = ` \u00b7 edited ${getRelativeTime(editedAt)}`; // middle-dot = \u00b7
                                el.parentElement.appendChild(editedDateElement);
                            }
                        } else if (deletedAuthor && !deletedPost) {
                            // if the post was not edited, make a link to only show the deleted author
                            el.classList.add("showAuthorOnly");
                        }
                    }
                });
            });
            // If the url has changed, check for edited submissions again
            // This is an async fetch that will check for edited submissions again when it is done
            if (currentURL !== window.location.href) {
                logging.info(`URL changed from ${currentURL} to ${window.location.href}`);
                currentURL = window.location.href;
                checkForEditedSubmissions();
            }
        }
        // old Reddit
        else {
            selectors = [
                ".entry p.tagline time:not(.found)", // Comment or Submission "last edited" timestamp
                ".entry p.tagline em:not(.found), .entry p.tagline span:first-of-type:not(.found)", // Comment "[deleted]" author
                "div[data-url] p.tagline span:first-of-type:not(.found)", // Submission "[deleted]" author
                "div[data-url] .usertext-body em:not(.found)", // Submission "[removed]" body
            ];
            elementsToCheck = Array.from(document.querySelectorAll(selectors.join(", ")));
            editedComments = elementsToCheck.filter(function (el) {
                el.classList.add("found");
                const isEditedRemovedOrDeletedAuthor =
                    el.title.substring(0, 11) === "last edited" || // include edited comments or submissions
                    el.innerText === "[deleted]" || // include comments or submissions deleted by user
                    el.innerText === "[removed]"; // include comments or submissions removed by moderator
                // if the element is a deleted author and not edited or removed, only show the deleted author
                if (
                    el.innerText === "[deleted]" &&
                    el.tagName.toUpperCase() === "SPAN" && // tag name is span (not em as it appears for deleted comments)
                    ["[deleted]", "[removed]"].indexOf(el.closest(".entry")?.querySelector(".md")?.innerText) === -1 // content of post is not deleted or removed
                ) {
                    el.classList.add("showAuthorOnly");
                }
                // keep element if it is edited or removed or if it has a deleted author
                return isEditedRemovedOrDeletedAuthor;
            });
        }
        // create links
        editedComments.forEach(function (el) {
            // for removed submissions, add the link to an element in the tagline instead of the body
            if (el.closest(".usertext-body") && el.innerText === "[removed]") {
                el = el.closest(".entry")?.querySelector("p.tagline span:first-of-type") || el;
            }
            createLink(el);
        });
    }

    /**
     * If the script timeout is not already set, set it and
     * run the findEditedComments in a second, otherwise do nothing.
     */
    function waitAndFindEditedComments() {
        if (!scriptTimeout) {
            scriptTimeout = setTimeout(findEditedComments, 1000);
        }
    }

    /**
     * Check for edited submissions using the Reddit JSON API.
     *
     * Since the Reddit Redesign website does not show if a submission was edited,
     * we will check the data in the Reddit JSON API for the information.
     */
    function checkForEditedSubmissions() {
        // don't need to check if we're not on a submission page or list view
        if (!document.querySelector(".Post, .ListingLayout-backgroundContainer")) {
            return;
        }
        // append .json to the page URL but before the ?
        const [url, query] = window.location.href.split("?");
        const jsonUrl = `${url}.json` + (query ? `?${query}` : "");
        logging.info(`Fetching additional info from ${jsonUrl}`);
        fetch(jsonUrl)
            .then(function (response) {
                if (!response.ok) {
                    throw new Error(`${response.status} ${response.statusText}`);
                }
                return response.json();
            })
            .then(function (data) {
                logging.info("Response:", data);
                const out = data?.length ? data[0] : data;
                const children = out?.data?.children;
                if (children) {
                    editedSubmissions = children
                        .filter(function (post) {
                            return post.kind === "t3" && (post.data.edited || post.data.author === "[deleted]");
                        })
                        .map(function (post) {
                            return {
                                id: post.data.id,
                                edited: post.data.edited,
                                deletedAuthor: post.data.author === "[deleted]",
                                deletedPost: post.data.selftext === "[deleted]" || post.data.selftext === "[removed]",
                            };
                        });
                    logging.info("Edited submissions:", editedSubmissions);
                    setTimeout(findEditedComments, 1000);
                }
            })
            .catch(function (error) {
                logging.error(`Error fetching additional info from ${jsonUrl}`, error);
            });
    }

    // check for new comments when you scroll
    window.addEventListener("scroll", waitAndFindEditedComments, true);

    // check for new comments when you click
    document.body.addEventListener("click", waitAndFindEditedComments, true);

    // add additional styling, find edited comments, and set old reddit status on page load
    window.addEventListener("load", function () {
        // determine if reddit is old or redesign
        isOldReddit = /old\.reddit/.test(window.location.href) || !!document.querySelector("#header-img");
        // Reddit redesign
        if (!isOldReddit) {
            // fix styling of created paragraphs in new reddit
            document.head.insertAdjacentHTML(
                "beforeend",
                `<style>
                    p.og {
                        background: rgb(255, 245, 157) !important;
                        color: black !important;
                        opacity: 0.96;
                        font-size: 14px;
                        padding: 16px;
                        line-height: 20px;
                        width: auto;
                        width: -moz-available;
                        width: -webkit-fill-available;
                    }
                    p.og pre {
                        font-family: monospace;
                        background: #fff59d;
                        padding: 6px;
                        margin: 6px 0;
                        color: black;
                    }
                    p.og h1, p.og h2, p.og h3, p.og h4, p.og h5, p.og h6, p.og p, p.og div {
                        margin: 1em 0 0.5em 0;
                    }
                    p.og h1 {
                        font-size: 2em;
                    }
                    p.og h2 {
                        font-size: 1.5em;
                    }
                    p.og>h3:first-child {
                        font-weight: bold;
                        margin-bottom: 0.5em;
                    }
                    p.og h3 {
                        font-size: 1.17em;
                    }
                    p.og h4 {
                        font-size: 1em;
                    }
                    p.og h5 {
                        font-size: 0.83em;
                    }
                    p.og h6 {
                        font-size: 0.67em;
                    }
                    p.og a {
                        color: #3e88a0;
                        text-decoration: underline;
                    }
                    p.og pre {
                        background: #d7d085 !important;
                    }
                    p.og :not(pre)>code {
                        font-family: monospace;
                        background: #d7d085 !important;
                        padding: 1px !important;
                    }
                    p.og summary {
                        cursor: pointer;
                    }
                    p.og hr {
                        border: none;
                        border-bottom: 1px solid #666;
                        background: transparent;
                    }
                    p.og table {
                        border: 2px solid black;
                    }
                    p.og table td, p.og table th {
                        border: 1px solid black;
                        padding: 4px;
                    }
                    p.og sup {
                        position: relative;
                        font-size: .7em;
                        line-height: .7em;
                        top: -0.4em;
                    }
                    span.md-spoiler-text {
                        background: #545452;
                        border-radius: 2px;
                        transition: background 1s ease-out;
                        cursor: pointer;
                        color: #545452;
                    }
                    span.md-spoiler-text.revealed {
                        background: rgba(84,84,82,.1);
                        color: inherit;
                    }
                    p.og em {
                        font-style: italic;
                    }
                    p.og strong {
                        font-weight: bold;
                    }
                    p.og blockquote {
                        border-left: 4px solid #c5c1ad;
                        padding: 0 8px;
                        margin-left: 5px;
                        margin-top: 0.35714285714285715em;
                        margin-bottom: 0.35714285714285715em;
                    }
                    p.og ol {
                        list-style: auto;
                        margin-left: 1.5em;
                    }
                    p.og ul {
                        list-style: initial;
                        margin-left: 1.5em;
                    }
                    span.edited-date {
                        font-size: small;
                    }
                </style>`
            );
            // listen for spoilertext in original body to be revealed
            window.addEventListener(
                "click",
                function (e) {
                    /**
                     * @type {HTMLSpanElement}
                     */
                    const spoiler = e.target.closest("span.md-spoiler-text");
                    if (spoiler) {
                        spoiler.classList.add("revealed");
                        spoiler.removeAttribute("title");
                        spoiler.style.cursor = "auto";
                    }
                },
                false
            );
            // check for edited submissions
            checkForEditedSubmissions();
        }
        // Old Reddit
        else {
            // fix styling of created paragraphs in old reddit
            document.head.insertAdjacentHTML(
                "beforeend",
                `<style>
                    div p.og {
                        background: rgb(255, 245, 157) !important;
                        color: black !important;
                        opacity: 0.96;
                        font-size: 14px;
                        padding: 16px;
                        line-height: 20px;
                    }
                    p.og p, p.og h1, p.og h2, p.og h3, p.og h4, p.og h5, p.og h6, p.og pre, p.og :not(pre)>code, p.og div {
                        color: black !important;
                        margin: 0.4em 0 0.2em 0;
                    }
                    p.og :not(pre)>code {
                        background: #d7d085 !important;
                        padding: 1px !important;
                    }
                    div p.og a {
                        color: #0079d3 !important;
                    }
                    div p.og a:visited {
                        color: #469ad8!important;
                    }
                    p.og table {
                        border: 2px solid black;
                    }
                    p.og table td, p.og table th {
                        border: 1px solid black;
                        padding: 4px;
                    }
                    p.og table tr {
                        background: none !important;
                    }
                    p.og strong {
                        font-weight: 600;
                    }
                    p.og em {
                        font-style: italic;
                    }
                    /* Override for RES Night mode */
                    .res-nightmode .entry.res-selected .md-container > .md p.og,
                    .res-nightmode .entry.res-selected .md-container > .md p.og p {
                        color: black !important;
                    }
                </style>`
            );
        }
        // find edited comments
        findEditedComments();
    });
})();
