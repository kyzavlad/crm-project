<?php
/**
 * Dating.com adapter — Phase 1: browser-assisted read-only sync
 *
 * Approach:
 *   The operator opens dating.com chats in their own browser session, then runs
 *   a bookmarklet. The bookmarklet reads already-called chat URLs from the
 *   browser performance API, re-fetches the messages using the browser's own
 *   session cookies (credentials:include to api.dating.com only), and POSTs
 *   sanitized message data to our WordPress import endpoint. No cookies,
 *   tokens, or auth headers are ever sent to our server.
 *
 * Confirmed endpoints (browser inspection 2026-05-25):
 *   GET https://api.dating.com/dialogs/messages/{op_id}:{contact_id}?omit=0&select=50
 *   GET https://api.dating.com/users/private/{op_id}  (self-profile only)
 *
 * NOT implemented (Phase 2, pending confirmation):
 *   - Server-side login / auth
 *   - Contact list / inbox endpoint
 *   - Send message
 *
 * NEVER in this file:
 *   - Captcha bypass / headless browser
 *   - Akamai / Cloudflare bypass
 *   - Hardcoded cookies, tokens, or credentials
 *   - Broadcast / mass outreach
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! defined( 'DC_API_BASE' ) ) {
	define( 'DC_API_BASE', 'https://api.dating.com' );
}

// ─────────────────────────────────────────────
// Cookie / session helpers (Phase 2 — server-side only)
// ─────────────────────────────────────────────

function dc_get_cookie_file( $id ) {
	$id_model   = get_field( 'id_model', $id );
	$upload_dir = wp_upload_dir();
	$cookie_dir = $upload_dir['basedir'] . '/cookies/';
	if ( ! file_exists( $cookie_dir ) ) {
		wp_mkdir_p( $cookie_dir );
	}
	return $cookie_dir . 'cookie_dating_com_' . $id_model . '.txt';
}

// ─────────────────────────────────────────────
// Authentication — PENDING (Phase 2)
// ─────────────────────────────────────────────

/**
 * Authentication stub — always returns false.
 * NOT IMPLEMENTED — login endpoint and form fields not yet confirmed.
 * TODO: implement after DATING_COM_BROWSER_INSPECTION.md Section 1 is confirmed.
 */
function dc_authenticate( $id, $cookie_file ) {
	return false;
}

// ─────────────────────────────────────────────
// HTTP helpers (Phase 2 server-side use)
// ─────────────────────────────────────────────

function dc_get_common_headers() {
	return [
		'Accept: application/json, text/javascript, */*; q=0.01',
		'Accept-Encoding: gzip, deflate, br',
		'Accept-Language: en-US,en;q=0.9',
		'Connection: keep-alive',
		'Host: api.dating.com',
		'Origin: https://dating.com',
		'Referer: https://dating.com/',
		'Sec-Fetch-Dest: empty',
		'Sec-Fetch-Mode: cors',
		'Sec-Fetch-Site: same-site',
		'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		'X-Requested-With: XMLHttpRequest',
	];
}

function dc_make_request( $url, $cookie_file, $headers = null ) {
	if ( $headers === null ) {
		$headers = dc_get_common_headers();
	}
	$ch = curl_init();
	curl_setopt( $ch, CURLOPT_URL, $url );
	curl_setopt( $ch, CURLOPT_RETURNTRANSFER, true );
	curl_setopt( $ch, CURLOPT_COOKIEFILE, $cookie_file );
	curl_setopt( $ch, CURLOPT_FOLLOWLOCATION, true );
	curl_setopt( $ch, CURLOPT_HTTPHEADER, $headers );
	curl_setopt( $ch, CURLOPT_ENCODING, 'gzip, deflate, br' );
	curl_setopt( $ch, CURLOPT_USERAGENT, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' );
	$response  = curl_exec( $ch );
	$http_code = curl_getinfo( $ch, CURLINFO_HTTP_CODE );
	$error     = curl_error( $ch );
	curl_close( $ch );
	return [ $http_code, $response, $error ];
}

// ─────────────────────────────────────────────
// Per-model import token (token-based auth for bookmarklet)
// ─────────────────────────────────────────────

/**
 * Returns (or creates) a random 40-char import token for a model.
 * Stored in post meta. Token is shown in the bookmarklet; it proves the
 * operator viewed the CRM model page. No WordPress session needed at import time.
 */
function dc_get_model_import_token( $model_id ) {
	$token = get_post_meta( $model_id, '_dc_import_token', true );
	if ( ! $token ) {
		$token = wp_generate_password( 40, false );
		update_post_meta( $model_id, '_dc_import_token', $token );
	}
	return $token;
}

function dc_verify_import_token( $model_id, $token ) {
	if ( ! $model_id || ! $token ) {
		return false;
	}
	$stored = get_post_meta( $model_id, '_dc_import_token', true );
	return $stored && hash_equals( $stored, $token );
}

// ─────────────────────────────────────────────
// Local storage helpers
// ─────────────────────────────────────────────

function dc_get_stored_contacts( $model_id ) {
	$v = get_post_meta( $model_id, '_dc_contacts', true );
	return is_array( $v ) ? $v : [];
}

function dc_get_stored_messages( $model_id, $contact_id ) {
	$key = '_dc_messages_' . sanitize_key( $contact_id );
	$v   = get_post_meta( $model_id, $key, true );
	return is_array( $v ) ? $v : [];
}

function dc_get_favorite_contacts( $model_id ) {
	$v = get_post_meta( $model_id, '_dc_favorite_contacts', true );
	return is_array( $v ) ? $v : [];
}

// ─────────────────────────────────────────────
// AJAX — Import messages (called by bookmarklet)
// ─────────────────────────────────────────────

add_action( 'wp_ajax_dc_import_messages',        'dc_handle_import_messages_ajax' );
add_action( 'wp_ajax_nopriv_dc_import_messages', 'dc_handle_import_messages_ajax' );

function dc_handle_import_messages_ajax() {
	// CORS — bookmarklet runs on https://dating.com and POSTs here.
	// FormData POST is a "simple" CORS request (no preflight needed).
	$allowed_origins = [ 'https://dating.com', 'https://www.dating.com' ];
	$origin = isset( $_SERVER['HTTP_ORIGIN'] ) ? $_SERVER['HTTP_ORIGIN'] : '';
	if ( in_array( $origin, $allowed_origins, true ) ) {
		header( 'Access-Control-Allow-Origin: ' . $origin );
		header( 'Vary: Origin' );
	}

	$model_id = intval( $_POST['model_id'] ?? 0 );
	$token    = sanitize_text_field( $_POST['token'] ?? '' );

	if ( ! $model_id || ! dc_verify_import_token( $model_id, $token ) ) {
		wp_send_json_error( 'Недействительный токен. Обновите страницу модели в CRM.' );
	}

	if ( get_field( 'source_model', $model_id ) !== 'dating_com' ) {
		wp_send_json_error( 'Модель не является Dating.com.' );
	}

	$operator_id  = sanitize_text_field( $_POST['operator_id'] ?? '' );
	$contact_id   = sanitize_text_field( $_POST['contact_id'] ?? '' );
	$messages_raw = isset( $_POST['messages'] ) ? wp_unslash( $_POST['messages'] ) : '[]';

	if ( $operator_id === '' || $contact_id === '' ) {
		wp_send_json_error( 'Отсутствуют operator_id или contact_id.' );
	}

	if ( ! ctype_digit( $operator_id ) || ! ctype_digit( $contact_id ) ) {
		wp_send_json_error( 'Некорректный формат ID (ожидаются только цифры).' );
	}

	$raw_messages = json_decode( $messages_raw, true );
	if ( ! is_array( $raw_messages ) ) {
		wp_send_json_error( 'Неверный формат данных сообщений.' );
	}

	// Sanitize — keep only expected scalar fields, drop everything else
	$sanitized = [];
	foreach ( $raw_messages as $msg ) {
		if ( ! is_array( $msg ) ) {
			continue;
		}
		$sanitized[] = [
			'id'        => intval( $msg['id'] ?? 0 ),
			'sender'    => sanitize_text_field( (string) ( $msg['sender'] ?? '' ) ),
			'recipient' => sanitize_text_field( (string) ( $msg['recipient'] ?? '' ) ),
			'timestamp' => intval( $msg['timestamp'] ?? 0 ),
			'read'      => ! empty( $msg['read'] ) ? 1 : 0,
			'text'      => sanitize_textarea_field( mb_substr( (string) ( $msg['text'] ?? '' ), 0, 2000 ) ),
			'tag'       => sanitize_text_field( (string) ( $msg['tag'] ?? '' ) ),
			'status'    => sanitize_text_field( (string) ( $msg['status'] ?? '' ) ),
		];
	}

	// Merge with existing messages, de-duplicated by id
	$existing = dc_get_stored_messages( $model_id, $contact_id );
	$indexed  = [];
	foreach ( $existing as $m ) {
		if ( ! empty( $m['id'] ) ) {
			$indexed[ $m['id'] ] = $m;
		}
	}
	foreach ( $sanitized as $m ) {
		if ( ! empty( $m['id'] ) ) {
			$indexed[ $m['id'] ] = $m;
		}
	}
	usort( $indexed, function ( $a, $b ) {
		return (int) $a['timestamp'] - (int) $b['timestamp'];
	} );
	$merged = array_values( $indexed );

	update_post_meta( $model_id, '_dc_messages_' . sanitize_key( $contact_id ), $merged );

	// Update contact index
	$contacts  = dc_get_stored_contacts( $model_id );
	$last      = ! empty( $merged ) ? end( $merged ) : null;
	$last_text = $last ? (string) ( $last['text'] ?? '' ) : '';
	$last_ts   = $last ? (int) ( $last['timestamp'] ?? 0 ) : 0;

	$unread = 0;
	foreach ( $merged as $m ) {
		if ( (string) $m['sender'] !== (string) $operator_id && empty( $m['read'] ) ) {
			$unread++;
		}
	}

	$found = false;
	foreach ( $contacts as &$c ) {
		if ( (string) $c['contact_id'] === (string) $contact_id ) {
			$c['operator_id']    = $operator_id;
			$c['last_message']   = mb_substr( $last_text, 0, 120 );
			$c['last_timestamp'] = $last_ts;
			$c['unread_count']   = $unread;
			$c['import_time']    = time();
			$found = true;
			break;
		}
	}
	unset( $c );

	if ( ! $found ) {
		$contacts[] = [
			'contact_id'     => $contact_id,
			'operator_id'    => $operator_id,
			'last_message'   => mb_substr( $last_text, 0, 120 ),
			'last_timestamp' => $last_ts,
			'unread_count'   => $unread,
			'import_time'    => time(),
		];
	}

	usort( $contacts, function ( $a, $b ) {
		return (int) $b['last_timestamp'] - (int) $a['last_timestamp'];
	} );

	update_post_meta( $model_id, '_dc_contacts', array_values( $contacts ) );

	wp_send_json_success( [
		'imported'       => count( $sanitized ),
		'total_messages' => count( $merged ),
		'contact_id'     => $contact_id,
	] );
}

// ─────────────────────────────────────────────
// AJAX — Background connector status
// ─────────────────────────────────────────────
// Called by the Node.js connector (sync_action=update) to report heartbeat,
// and by the CRM sync panel JS (sync_action=get) to display status.
// Authenticated by the per-model import token — no WP session required.

add_action( 'wp_ajax_dc_bg_sync_status',        'dc_handle_bg_sync_status' );
add_action( 'wp_ajax_nopriv_dc_bg_sync_status', 'dc_handle_bg_sync_status' );

function dc_handle_bg_sync_status() {
	$model_id = intval( $_POST['model_id'] ?? 0 );
	$token    = sanitize_text_field( $_POST['token'] ?? '' );

	if ( ! $model_id || ! dc_verify_import_token( $model_id, $token ) ) {
		wp_send_json_error( 'Недействительный токен.' );
	}

	$sync_action = sanitize_text_field( $_POST['sync_action'] ?? 'get' );

	if ( $sync_action === 'update' ) {
		$allowed_statuses = [ 'ok', 'warning', 'error' ];
		$status   = sanitize_text_field( $_POST['status'] ?? 'ok' );
		$status   = in_array( $status, $allowed_statuses, true ) ? $status : 'ok';
		$err_msg  = sanitize_text_field( mb_substr( (string) ( $_POST['error'] ?? '' ), 0, 300 ) );
		$imported = intval( $_POST['imported'] ?? 0 );

		update_post_meta( $model_id, '_dc_bg_sync_last_time',   time() );
		update_post_meta( $model_id, '_dc_bg_sync_last_status', $status );
		update_post_meta( $model_id, '_dc_bg_sync_last_error',  $err_msg );
		update_post_meta( $model_id, '_dc_bg_sync_imported',    $imported );

		wp_send_json_success( 'ok' );
		return;
	}

	// Default: return current status for the CRM panel
	$last_time   = get_post_meta( $model_id, '_dc_bg_sync_last_time',   true );
	$last_status = get_post_meta( $model_id, '_dc_bg_sync_last_status', true );
	$last_error  = get_post_meta( $model_id, '_dc_bg_sync_last_error',  true );
	$imported    = get_post_meta( $model_id, '_dc_bg_sync_imported',    true );

	wp_send_json_success( [
		'last_time'   => $last_time   ? esc_html( date( 'd.m.Y H:i', (int) $last_time ) ) : null,
		'last_status' => esc_html( $last_status ?: 'unknown' ),
		'last_error'  => esc_html( (string) ( $last_error ?: '' ) ),
		'imported'    => (int) ( $imported ?: 0 ),
	] );
}

/**
 * Called from handle_toggle_favorite() in functions.php when source_model === 'dating_com'.
 * Stores favourite contact IDs in _dc_favorite_contacts post meta.
 */
function dc_handle_toggle_favorite( $model_id, $contact_id ) {
	$contact_id = (string) $contact_id;
	if ( ! ctype_digit( $contact_id ) ) {
		wp_send_json_error( 'Некорректный ID контакта.' );
	}
	$favorites = dc_get_favorite_contacts( $model_id );
	if ( in_array( $contact_id, $favorites, true ) ) {
		$favorites = array_values( array_filter( $favorites, function ( $c ) use ( $contact_id ) {
			return $c !== $contact_id;
		} ) );
		$is_fav = false;
	} else {
		$favorites[] = $contact_id;
		$is_fav      = true;
	}
	update_post_meta( $model_id, '_dc_favorite_contacts', $favorites );
	wp_send_json_success( [ 'favorite' => $is_fav ? '1' : '0' ] );
}

// ─────────────────────────────────────────────
// AJAX handler — Contact list (reads local storage)
// ─────────────────────────────────────────────

function dc_handle_get_contact_list( $id ) {
	$contacts  = dc_get_stored_contacts( $id );
	$favorites = dc_get_favorite_contacts( $id );

	if ( empty( $contacts ) ) {
		wp_send_json_success( dc_render_no_contacts_hint() );
		return;
	}

	// Sort: favorites first, then by last_timestamp DESC (already sorted on import)
	$fav_set  = array_flip( $favorites );
	$fav_list = [];
	$reg_list = [];
	foreach ( $contacts as $c ) {
		if ( isset( $fav_set[ (string) $c['contact_id'] ] ) ) {
			$fav_list[] = $c;
		} else {
			$reg_list[] = $c;
		}
	}
	$ordered = array_merge( $fav_list, $reg_list );

	$html = '';
	foreach ( $ordered as $c ) {
		$cid       = esc_attr( $c['contact_id'] );
		$last_text = esc_html( mb_substr( (string) ( $c['last_message'] ?? '' ), 0, 70 ) );
		$last_time = ! empty( $c['last_timestamp'] )
		           ? esc_html( date( 'd.m H:i', (int) $c['last_timestamp'] ) )
		           : '';
		$unread    = (int) ( $c['unread_count'] ?? 0 );
		$is_fav    = isset( $fav_set[ (string) $c['contact_id'] ] );

		$row_class  = $is_fav ? 'dc-contact is-favorite' : 'dc-contact';
		$star       = $is_fav ? '★' : '☆';
		$star_title = $is_fav ? 'Убрать из избранных' : 'В избранные';
		$fav_val    = $is_fav ? '1' : '0';
		$last_ts    = (int) ( $c['last_timestamp'] ?? 0 );

		$unread_badge = $unread > 0
			? '<span class="dc-unread-badge">' . $unread . '</span> '
			: '';

		$html .= '<div class="' . $row_class . '"'
		       . ' data-contact_id="' . $cid . '"'
		       . ' data-last_ts="' . $last_ts . '"'
		       . ' data-unread="' . $unread . '"'
		       . '>'
		       . '<button class="dc-fav-btn" id="goFavorite"'
		       .         ' data-user_id="' . $cid . '"'
		       .         ' data-favorite="' . $fav_val . '"'
		       .         ' title="' . esc_attr( $star_title ) . '">'
		       .   '<span class="favorite-indicator">' . $star . '</span>'
		       . '</button>'
		       . '<div class="dc-contact-info" id="openChat"'
		       .     ' data-user_id="' . $cid . '"'
		       .     ' data-chat_id="0">'
		       .   '<div class="dc-contact-main">'
		       .     '<div class="dc-contact-left">'
		       .       '<span class="dc-contact-id">ID: ' . esc_html( $c['contact_id'] ) . '</span>'
		       .       $unread_badge
		       .       '<div class="dc-contact-preview">' . $last_text . '</div>'
		       .     '</div>'
		       .     '<div class="dc-contact-time">' . $last_time . '</div>'
		       .   '</div>'
		       . '</div>'
		       . '</div>';
	}

	wp_send_json_success( $html );
}

// ─────────────────────────────────────────────
// Timestamp helper — Dating.com returns ms, PHP date() expects seconds
// ─────────────────────────────────────────────

/**
 * Normalise a Dating.com message timestamp to a valid Unix second.
 * The API returns JavaScript milliseconds (13-digit numbers).
 * Returns 0 for missing, zero, or out-of-range values so callers
 * can show a safe fallback instead of a nonsensical year.
 */
function dc_safe_timestamp( $raw ) {
	$ts = (int) $raw;
	if ( $ts <= 0 ) {
		return 0;
	}
	// 13-digit value → milliseconds → convert to seconds
	if ( $ts > 9_999_999_999 ) {
		$ts = (int) ( $ts / 1000 );
	}
	// Sanity: must be between 2000-01-01 and 2100-01-01
	if ( $ts < 946684800 || $ts > 4102444800 ) {
		return 0;
	}
	return $ts;
}

// ─────────────────────────────────────────────
// AJAX handler — Open chat (reads local storage)
// ─────────────────────────────────────────────

function dc_handle_open_chat( $id, $contact_id ) {
	$messages = dc_get_stored_messages( $id, $contact_id );
	$op_id    = get_field( 'id_model', $id );

	$html  = '<div class="chat-user-info d-flex gap-3 mb-3">';
	$html .= '<div class="information">';
	$html .= '<h5 class="mb-2"><strong>Dating.com</strong></h5>';
	$html .= '<p class="m-0">&#x1F4AC; Контакт ID: ' . esc_html( $contact_id ) . '</p>';
	$html .= '</div></div>';

	$html .= '<div class="messages">';
	$html .= '<div class="chat-messages" data-chat_id="0"'
	       . ' data-user_id="' . esc_attr( $contact_id ) . '"'
	       . ' data-source="dating_com">';

	if ( empty( $messages ) ) {
		$html .= '<div class="text-center text-muted p-4">'
		       . '<p><strong>Нет импортированных сообщений</strong></p>'
		       . '<p>Откройте этот чат на <a href="https://dating.com" target="_blank" rel="noopener">Dating.com</a>'
		       . ' и запустите буклет синхронизации со страницы модели.</p>'
		       . '</div>';
	} else {
		foreach ( $messages as $msg ) {
			$is_outbound = ( (string) ( $msg['sender'] ?? '' ) === (string) $op_id );
			$align       = $is_outbound ? 'text-end text-success' : 'text-start text-primary';
			$sender      = $is_outbound ? 'Модель' : 'Клиент';
			$text        = isset( $msg['text'] ) ? esc_html( $msg['text'] ) : '';
			$ts          = dc_safe_timestamp( $msg['timestamp'] ?? 0 );
			$date        = $ts > 0 ? esc_html( date( 'd.m.Y H:i', $ts ) ) : '—';

			$html .= '<div class="chat-message ' . $align . ' mb-3">'
			       . '<p>' . $sender . ' ( <small>' . $date . '</small> )</p>'
			       . '<p class="text-dark" style="font-size:14px;">' . $text . '</p>'
			       . '</div>';
		}
	}

	$html .= '</div></div>';

	wp_send_json_success( $html );
}

// ─────────────────────────────────────────────
// AJAX handler — Check / poll messages (reads local storage)
// ─────────────────────────────────────────────

function dc_handle_check_message( $id, $contact_id ) {
	$messages = dc_get_stored_messages( $id, $contact_id );
	$op_id    = get_field( 'id_model', $id );

	$html = '<div class="chat-messages" data-chat_id="0"'
	      . ' data-user_id="' . esc_attr( $contact_id ) . '"'
	      . ' data-source="dating_com">';

	if ( empty( $messages ) ) {
		$html .= '<div class="text-center text-muted p-4"><p>Нет импортированных сообщений.</p></div>';
	} else {
		foreach ( $messages as $msg ) {
			$is_outbound = ( (string) ( $msg['sender'] ?? '' ) === (string) $op_id );
			$align       = $is_outbound ? 'text-end text-success' : 'text-start text-primary';
			$sender      = $is_outbound ? 'Модель' : 'Клиент';
			$text        = isset( $msg['text'] ) ? esc_html( $msg['text'] ) : '';
			$ts          = dc_safe_timestamp( $msg['timestamp'] ?? 0 );
			$date        = $ts > 0 ? esc_html( date( 'd.m.Y H:i', $ts ) ) : '—';

			$html .= '<div class="chat-message ' . $align . ' mb-3">'
			       . '<p>' . $sender . ' ( <small>' . $date . '</small> )</p>'
			       . '<p class="text-dark" style="font-size:14px;">' . $text . '</p>'
			       . '</div>';
		}
	}

	$html .= '</div>';

	wp_send_json_success( $html );
}

// ─────────────────────────────────────────────
// Sync panel & bookmarklet
// ─────────────────────────────────────────────

function dc_render_no_contacts_hint() {
	return '<div class="text-center text-muted mt-3 mb-3 p-3" style="border:1px dashed #e91e8c;border-radius:6px;">'
	     . '<strong style="color:#e91e8c;">Dating.com</strong><br>'
	     . '<small>Контакты не синхронизированы.<br>'
	     . 'Используйте буклет синхронизации на этой странице.</small>'
	     . '</div>';
}

/**
 * Renders the Dating.com sync helper panel for the model detail page.
 * Outputs Russian instructions, a draggable bookmarklet button,
 * a readonly textarea with the full console snippet, a copy-to-clipboard
 * button, and a contacts-refresh button.
 *
 * The bookmarklet code is built entirely in page JavaScript so that no PHP
 * string concatenation can generate malformed JS. Config values are passed
 * via wp_json_encode() and interpolated with JSON.stringify() in JS.
 */
function dc_render_sync_panel( $id ) {
	$token    = dc_get_model_import_token( $id );
	$ajax_url = admin_url( 'admin-ajax.php' );
	$cfg_json = wp_json_encode( [
		'ajax_url' => $ajax_url,
		'model_id' => (string) $id,
		'token'    => $token,
	] );

	ob_start();
	?>
	<div class="dc-sync-panel mt-4 p-3 rounded border" id="dc-sync-panel">
		<h6 class="fw-bold mb-3">
			<span style="color:#c2185b;">&#9670;</span>
			<span style="color:#c2185b;">Dating.com</span> — Синхронизация сообщений
		</h6>

		<ol class="dc-sync-steps mb-3">
			<li>Откройте <a href="https://dating.com" target="_blank" rel="noopener">Dating.com</a> в этом же браузере и войдите в аккаунт модели.</li>
			<li>Запустите DC Sync один раз: перетащите кнопку ниже в закладки и нажмите её — или скопируйте код кнопкой «Скопировать» и вставьте в консоль браузера (F12 → Console → Enter). Браузер покажет подтверждение.</li>
			<li>Открывайте нужные диалоги в Dating.com. Помощник автоматически импортирует каждый открытый чат.</li>
			<li>Вернитесь в CRM и нажмите <strong>«Обновить контакты»</strong>.</li>
		</ol>

		<div class="d-flex gap-2 flex-wrap mb-2 align-items-center">
			<a class="btn btn-sm btn-outline-secondary dc-bookmarklet"
			   id="dc-bookmarklet-link"
			   href="#"
			   title="Перетащите в панель закладок браузера">
				&#128278;&nbsp;DC&nbsp;Sync — перетащить в закладки
			</a>
			<button type="button"
			        class="btn btn-sm btn-outline-dark"
			        id="dc-copy-bookmarklet">
				&#128203;&nbsp;Скопировать код
			</button>
			<button type="button"
			        class="btn btn-sm btn-outline-primary"
			        id="dc-refresh-contacts">
				&#8635;&nbsp;Обновить контакты
			</button>
		</div>

		<textarea id="dc-bm-code"
		          class="form-control mt-2 mb-2"
		          readonly
		          rows="3"
		          style="font-size:11px;font-family:monospace;resize:vertical;"
		          placeholder="Загрузка кода…"></textarea>

		<div id="dc-sync-status" class="text-muted" style="font-size:12px;min-height:18px;"></div>
		<p class="text-muted mt-2 mb-0" style="font-size:11px;">
			Живые обновления работают, пока DC Sync активен во вкладке Dating.com.
		</p>

		<!-- Connector config for easy copying into config.js -->
		<details class="mt-3">
			<summary style="font-size:12px;cursor:pointer;color:#888;">&#9881; Конфиг для фонового коннектора (config.js)</summary>
			<pre id="dc-connector-cfg" class="mt-2 p-2 rounded" style="font-size:11px;background:#f8f9fa;border:1px solid #dee2e6;user-select:all;white-space:pre-wrap;">Загрузка…</pre>
		</details>

		<!-- Background connector status -->
		<div class="mt-3 p-2 rounded" style="background:#f8f9fa;border:1px solid #dee2e6;">
			<div class="d-flex justify-content-between align-items-center">
				<strong style="font-size:12px;">Фоновый коннектор</strong>
				<span id="dc-bg-badge" class="badge bg-secondary" style="font-size:10px;">Загрузка…</span>
			</div>
			<div id="dc-bg-details" class="text-muted mt-1" style="font-size:11px;">—</div>
		</div>
	</div>

	<script>
	document.addEventListener('DOMContentLoaded', function(){
		var cfg = <?= $cfg_json; ?>;
		var W = JSON.stringify(cfg.ajax_url);
		var M = JSON.stringify(cfg.model_id);
		var T = JSON.stringify(cfg.token);

		var elLink    = document.getElementById('dc-bookmarklet-link');
		var elCode    = document.getElementById('dc-bm-code');
		var elCopy    = document.getElementById('dc-copy-bookmarklet');
		var elRefresh = document.getElementById('dc-refresh-contacts');
		var elStatus  = document.getElementById('dc-sync-status');

		// ── Helper: send sanitized message array to CRM import endpoint ──────────
		// Defined as a JS string fragment reused in both interceptor and fallback.
		// snd(o, c, msgs): o=operator_id string, c=contact_id string, msgs=array
		var sndFn = ""
			+ "function snd(o,c,msgs){"
			+   "if(!Array.isArray(msgs))return;"
			+   "var safe=msgs.map(function(m){"
			+     "return{id:+(m.id||0),sender:''+(m.sender||''),recipient:''+(m.recipient||''),"
			+           "timestamp:+(m.timestamp||0),read:m.read?1:0,"
			+           "text:(''+(m.text||'')).substring(0,2000),"
			+           "tag:''+(m.tag||''),status:''+(m.status||'')};"
			+   "});"
			+   "var fd=new FormData();"
			+   "fd.append('action','dc_import_messages');"
			+   "fd.append('token',T);"
			+   "fd.append('model_id',M);"
			+   "fd.append('operator_id',o);"
			+   "fd.append('contact_id',c);"
			+   "fd.append('messages',JSON.stringify(safe));"
			+   "fetch(W,{method:'POST',body:fd})"
			+   ".then(function(r){return r.json();})"
			+   ".then(function(r){"
			+     "if(r.success){imported++;console.log('DC Sync: импортировано диалогов: '+imported+' (контакт '+c+')');}"
			+     "else{console.warn('DC Sync: ошибка контакта '+c+': '+r.data);}"
			+   "})"
			+   ".catch(function(e){console.error('DC Sync: ошибка отправки:',e);});"
			+ "}";

		// ── Regex to match Dating.com message API URLs ────────────────────────────
		var reFrag = "/api\\.dating\\.com\\/dialogs\\/messages\\/(\\d+):(\\d+)/";

		// ── Build the full bookmarklet IIFE ───────────────────────────────────────
		var code = "(function(){"
			// Guard: don't install twice
			+ "if(window.__dcSyncActive){alert('DC Sync уже активен. Открывайте чаты Dating.com.');return;}"
			+ "window.__dcSyncActive=true;"
			+ "var W="+W+",M="+M+",T="+T+";"
			+ "var RE="+reFrag+";"
			+ "var imported=0;"
			+ sndFn

			// ── Patch window.fetch ───────────────────────────────────────────────
			+ "var _f=window.fetch;"
			+ "window.fetch=function(input,init){"
			+   "var url=typeof input==='string'?input:(input&&input.url?input.url:'');"
			+   "var p=_f.apply(this,arguments);"
			+   "var m=url.match(RE);"
			+   "if(m){"
			+     "p=p.then(function(resp){"
			+       "resp.clone().json().then(function(d){snd(m[1],m[2],d);}).catch(function(){});"
			+       "return resp;"
			+     "});"
			+   "}"
			+   "return p;"
			+ "};"

			// ── Patch XMLHttpRequest ─────────────────────────────────────────────
			+ "var _o=XMLHttpRequest.prototype.open;"
			+ "XMLHttpRequest.prototype.open=function(method,url){"
			+   "this._dcUrl=typeof url==='string'?url:'';"
			+   "return _o.apply(this,arguments);"
			+ "};"
			+ "var _s=XMLHttpRequest.prototype.send;"
			+ "XMLHttpRequest.prototype.send=function(){"
			+   "var x=this;"
			+   "if(x._dcUrl){"
			+     "var m=x._dcUrl.match(RE);"
			+     "if(m){x.addEventListener('load',function(){if(x.status===200){try{snd(m[1],m[2],JSON.parse(x.responseText));}catch(e){}}});}"
			+   "}"
			+   "return _s.apply(this,arguments);"
			+ "};"

			// ── Fallback: try any URLs already in the performance buffer ─────────
			+ "var es=performance.getEntriesByType?performance.getEntriesByType('resource'):[];"
			+ "var seen={};"
			+ "for(var i=0;i<es.length;i++){"
			+   "var em=es[i].name.match(RE);"
			+   "if(em&&!seen[em[1]+':'+em[2]]){"
			+     "seen[em[1]+':'+em[2]]=1;"
			+     "(function(o,c){"
			+       "fetch('https://api.dating.com/dialogs/messages/'+o+':'+c+'?omit=0&select=50',"
			+             "{credentials:'include',headers:{'Accept':'application/json'}})"
			+       ".then(function(r){"
			+         "if(!r.ok){"
			+           "if(r.status===401)"
			+             "console.log('DC Sync: прямой запрос отклонён (401) для контакта '+c+'. Откройте чат заново — перехватчик импортирует автоматически.');"
			+           "throw new Error('HTTP '+r.status);"
			+         "}"
			+         "return r.json();"
			+       "})"
			+       ".then(function(d){snd(o,c,d);})"
			+       ".catch(function(){});"
			+     "})(em[1],em[2]);"
			+   "}"
			+ "}"

			+ "alert('DC Sync включён. Теперь откройте нужные чаты Dating.com.');"
			+ "})();";

		elLink.href = 'javascript:' + encodeURIComponent(code);
		elCode.value = code;

		function copyFallback() {
			elCode.select();
			try {
				document.execCommand('copy');
				elStatus.textContent = 'Код скопирован (запасной метод).';
			} catch(e) {
				elStatus.textContent = 'Не удалось скопировать автоматически. Выделите код вручную (Ctrl+A в поле).';
			}
		}

		elCopy.addEventListener('click', function(){
			var bm = elCode.value;
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(bm).then(function(){
					elStatus.textContent = 'Код скопирован. Вставьте в консоль Dating.com (F12 > Console > Enter).';
				}).catch(copyFallback);
			} else {
				copyFallback();
			}
		});

		elRefresh.addEventListener('click', function(){
			elStatus.textContent = 'Обновление...';
			var fd = new FormData();
			fd.append('action', 'get_contact_list');
			fd.append('id', cfg.model_id);
			fetch(cfg.ajax_url, {method: 'POST', body: fd})
				.then(function(r){ return r.json(); })
				.then(function(r){
					var el = document.querySelector('.contact-list .response');
					if (r.success) {
						if (el) el.innerHTML = r.data;
						elStatus.textContent = 'Контакты обновлены.';
					} else {
						elStatus.textContent = 'Ошибка: ' + r.data;
					}
				})
				.catch(function(){
					elStatus.textContent = 'Ошибка при обновлении контактов.';
				});
		});

		// Connector config snippet for easy copying
		var elCfg = document.getElementById('dc-connector-cfg');
		if (elCfg) {
			elCfg.textContent = 'crmUrl:      "' + window.location.origin + '"\n'
				+ 'modelId:     ' + cfg.model_id + '\n'
				+ 'importToken: "' + cfg.token + '"';
		}

		// Background connector status polling
		function fetchBgStatus() {
			var fd = new FormData();
			fd.append('action',      'dc_bg_sync_status');
			fd.append('sync_action', 'get');
			fd.append('model_id',    cfg.model_id);
			fd.append('token',       cfg.token);
			fetch(cfg.ajax_url, {method: 'POST', body: fd})
				.then(function(r){ return r.json(); })
				.then(function(r){
					if (!r.success) return;
					var d       = r.data;
					var badge   = document.getElementById('dc-bg-badge');
					var details = document.getElementById('dc-bg-details');
					if (!badge || !details) return;
					if (!d.last_time) {
						badge.className   = 'badge bg-secondary';
						badge.textContent = 'Не запущен';
						details.textContent = 'Запустите: node connector/dc-connector.js';
						return;
					}
					badge.className = d.last_status === 'error'   ? 'badge bg-danger' :
					                  d.last_status === 'warning' ? 'badge bg-warning text-dark' :
					                                                'badge bg-success';
					badge.textContent = d.last_status === 'error'   ? 'Ошибка' :
					                    d.last_status === 'warning' ? 'Предупреждение' : 'Активен';
					var info = 'Последняя синхронизация: ' + d.last_time;
					if (d.imported > 0) info += ' · Импортировано: ' + d.imported;
					if (d.last_error)   info += ' · Ошибка: '        + d.last_error;
					details.textContent = info;
				})
				.catch(function(){});
		}
		fetchBgStatus();
		setInterval(fetchBgStatus, 60000);
	});
	</script>
	<?php
	return ob_get_clean();
}

// ─────────────────────────────────────────────
// ACF: register source_model field
// ─────────────────────────────────────────────

add_action( 'acf/init', 'dc_register_source_model_field' );
function dc_register_source_model_field() {
	if ( ! function_exists( 'acf_add_local_field_group' ) ) {
		return;
	}
	acf_add_local_field_group( [
		'key'    => 'group_crm_source_model',
		'title'  => 'Источник / Source',
		'fields' => [
			[
				'key'           => 'field_crm_source_model',
				'label'         => 'Источник',
				'name'          => 'source_model',
				'type'          => 'select',
				'choices'       => [
					'romance_compass' => 'RomanceCompass',
					'dating_com'      => 'Dating.com',
				],
				'default_value' => 'romance_compass',
				'required'      => 0,
				'return_format' => 'value',
				'instructions'  => 'Выберите платформу. По умолчанию: RomanceCompass.',
			],
		],
		'location' => [
			[
				[
					'param'    => 'post_type',
					'operator' => '==',
					'value'    => 'model',
				],
			],
		],
		'position'        => 'side',
		'style'           => 'default',
		'label_placement' => 'top',
		'active'          => true,
	] );
}
