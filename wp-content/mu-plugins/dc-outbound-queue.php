<?php
/**
 * Plugin Name: Dating.com CRM Outbound Queue
 * Description: Manual one-to-one messages from CRM are queued and sent by the authenticated Dating.com connector.
 * Version: 1.0.0
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const DCO_SCHEMA_VERSION = '1.0.0';

function dco_table_name() {
	global $wpdb;
	return $wpdb->prefix . 'dc_outbox';
}

function dco_install_table() {
	if ( get_option( 'dco_schema_version' ) === DCO_SCHEMA_VERSION ) {
		return;
	}

	global $wpdb;
	require_once ABSPATH . 'wp-admin/includes/upgrade.php';

	$table   = dco_table_name();
	$charset = $wpdb->get_charset_collate();

	$sql = "CREATE TABLE {$table} (
		id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		model_id BIGINT UNSIGNED NOT NULL,
		operator_id VARCHAR(32) NOT NULL DEFAULT '',
		contact_id VARCHAR(32) NOT NULL,
		message_text TEXT NOT NULL,
		status VARCHAR(20) NOT NULL DEFAULT 'pending',
		attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
		dating_status SMALLINT UNSIGNED NOT NULL DEFAULT 0,
		error_text TEXT NULL,
		created_at DATETIME NOT NULL,
		updated_at DATETIME NOT NULL,
		sent_at DATETIME NULL,
		PRIMARY KEY (id),
		KEY model_status (model_id, status),
		KEY created_at (created_at)
	) {$charset};";

	dbDelta( $sql );
	update_option( 'dco_schema_version', DCO_SCHEMA_VERSION, false );
}
add_action( 'init', 'dco_install_table', 5 );

function dco_verify_model_token( $model_id, $token ) {
	if ( ! $model_id || $token === '' ) {
		return false;
	}

	if ( function_exists( 'dc_verify_import_token' ) ) {
		return dc_verify_import_token( $model_id, $token );
	}

	$stored = (string) get_post_meta( $model_id, '_dc_import_token', true );
	return $stored !== '' && hash_equals( $stored, $token );
}

function dco_is_dating_model( $model_id ) {
	return function_exists( 'get_field' ) && get_field( 'source_model', $model_id ) === 'dating_com';
}

function dco_get_operator_id( $model_id, $contact_id = '' ) {
	$contacts = get_post_meta( $model_id, '_dc_contacts', true );
	if ( is_array( $contacts ) && $contact_id !== '' ) {
		foreach ( $contacts as $contact ) {
			if (
				is_array( $contact ) &&
				(string) ( $contact['contact_id'] ?? '' ) === (string) $contact_id &&
				ctype_digit( (string) ( $contact['operator_id'] ?? '' ) )
			) {
				return (string) $contact['operator_id'];
			}
		}
	}

	if ( function_exists( 'get_field' ) ) {
		$id_model = preg_replace( '/\D+/', '', (string) get_field( 'id_model', $model_id ) );
		if ( $id_model !== '' ) {
			return $id_model;
		}
	}

	if ( preg_match( '/(\d{9,15})/', get_the_title( $model_id ), $match ) ) {
		return $match[1];
	}

	return '';
}

add_action( 'wp_ajax_dc_outbox_enqueue', 'dco_ajax_enqueue' );
function dco_ajax_enqueue() {
	if ( ! is_user_logged_in() ) {
		wp_send_json_error( 'Требуется вход в CRM.', 401 );
	}

	$model_id  = absint( $_POST['model_id'] ?? 0 );
	$token     = sanitize_text_field( wp_unslash( $_POST['token'] ?? '' ) );
	$contact_id = preg_replace( '/\D+/', '', (string) wp_unslash( $_POST['contact_id'] ?? '' ) );
	$text       = trim( sanitize_textarea_field( wp_unslash( $_POST['text'] ?? '' ) ) );

	if ( ! dco_verify_model_token( $model_id, $token ) || ! dco_is_dating_model( $model_id ) ) {
		wp_send_json_error( 'Недействительный профиль или токен.', 403 );
	}
	if ( $contact_id === '' || ! ctype_digit( $contact_id ) ) {
		wp_send_json_error( 'Не удалось определить контакт Dating.com.', 400 );
	}
	if ( $text === '' ) {
		wp_send_json_error( 'Введите сообщение.', 400 );
	}
	if ( mb_strlen( $text ) > 2000 ) {
		wp_send_json_error( 'Сообщение длиннее 2000 символов.', 400 );
	}

	global $wpdb;
	$now         = current_time( 'mysql', true );
	$operator_id = dco_get_operator_id( $model_id, $contact_id );

	$ok = $wpdb->insert(
		dco_table_name(),
		[
			'model_id'      => $model_id,
			'operator_id'   => $operator_id,
			'contact_id'    => $contact_id,
			'message_text'  => $text,
			'status'        => 'pending',
			'attempts'      => 0,
			'dating_status' => 0,
			'error_text'    => '',
			'created_at'    => $now,
			'updated_at'    => $now,
		],
		[ '%d', '%s', '%s', '%s', '%s', '%d', '%d', '%s', '%s', '%s' ]
	);

	if ( ! $ok ) {
		wp_send_json_error( 'Не удалось поставить сообщение в очередь.', 500 );
	}

	wp_send_json_success( [
		'queue_id' => (int) $wpdb->insert_id,
		'status'   => 'pending',
	] );
}

add_action( 'wp_ajax_dc_outbox_recover', 'dco_ajax_recover' );
add_action( 'wp_ajax_nopriv_dc_outbox_recover', 'dco_ajax_recover' );
function dco_ajax_recover() {
	$model_id = absint( $_POST['model_id'] ?? 0 );
	$token    = sanitize_text_field( wp_unslash( $_POST['token'] ?? '' ) );

	if ( ! dco_verify_model_token( $model_id, $token ) ) {
		wp_send_json_error( 'Недействительный токен.', 403 );
	}

	global $wpdb;
	$table = dco_table_name();
	$now   = current_time( 'mysql', true );

	$recovered = $wpdb->query(
		$wpdb->prepare(
			"UPDATE {$table}
			 SET status = 'pending', updated_at = %s
			 WHERE model_id = %d AND status = 'processing'",
			$now,
			$model_id
		)
	);

	wp_send_json_success( [ 'recovered' => max( 0, (int) $recovered ) ] );
}

add_action( 'wp_ajax_dc_outbox_pull', 'dco_ajax_pull' );
add_action( 'wp_ajax_nopriv_dc_outbox_pull', 'dco_ajax_pull' );
function dco_ajax_pull() {
	$model_id = absint( $_POST['model_id'] ?? 0 );
	$token    = sanitize_text_field( wp_unslash( $_POST['token'] ?? '' ) );

	if ( ! dco_verify_model_token( $model_id, $token ) ) {
		wp_send_json_error( 'Недействительный токен.', 403 );
	}

	global $wpdb;
	$table = dco_table_name();
	$now   = current_time( 'mysql', true );

	// Fallback recovery for abandoned processing rows if startup recovery was missed.
	$wpdb->query(
		$wpdb->prepare(
			"UPDATE {$table}
			 SET status = 'pending', updated_at = %s
			 WHERE model_id = %d
			   AND status = 'processing'
			   AND updated_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 MINUTE)",
			$now,
			$model_id
		)
	);

	$wpdb->query( 'START TRANSACTION' );
	$row = $wpdb->get_row(
		$wpdb->prepare(
			"SELECT * FROM {$table}
			 WHERE model_id = %d AND status = 'pending'
			 ORDER BY id ASC
			 LIMIT 1
			 FOR UPDATE",
			$model_id
		),
		ARRAY_A
	);

	if ( ! $row ) {
		$wpdb->query( 'COMMIT' );
		wp_send_json_success( [ 'item' => null ] );
	}

	$updated = $wpdb->update(
		$table,
		[
			'status'     => 'processing',
			'attempts'   => (int) $row['attempts'] + 1,
			'updated_at' => $now,
			'error_text' => '',
		],
		[ 'id' => (int) $row['id'], 'status' => 'pending' ],
		[ '%s', '%d', '%s', '%s' ],
		[ '%d', '%s' ]
	);

	if ( ! $updated ) {
		$wpdb->query( 'ROLLBACK' );
		wp_send_json_success( [ 'item' => null ] );
	}

	$wpdb->query( 'COMMIT' );
	$row['status']   = 'processing';
	$row['attempts'] = (int) $row['attempts'] + 1;

	wp_send_json_success( [
		'item' => [
			'id'          => (int) $row['id'],
			'model_id'    => (int) $row['model_id'],
			'operator_id' => (string) $row['operator_id'],
			'contact_id'  => (string) $row['contact_id'],
			'text'        => (string) $row['message_text'],
			'attempts'    => (int) $row['attempts'],
		],
	] );
}

add_action( 'wp_ajax_dc_outbox_result', 'dco_ajax_result' );
add_action( 'wp_ajax_nopriv_dc_outbox_result', 'dco_ajax_result' );
function dco_ajax_result() {
	$model_id = absint( $_POST['model_id'] ?? 0 );
	$token    = sanitize_text_field( wp_unslash( $_POST['token'] ?? '' ) );
	$queue_id = absint( $_POST['queue_id'] ?? 0 );
	$status   = sanitize_key( $_POST['status'] ?? '' );
	$error    = sanitize_textarea_field( mb_substr( (string) wp_unslash( $_POST['error'] ?? '' ), 0, 1000 ) );
	$http     = absint( $_POST['dating_status'] ?? 0 );

	if ( ! dco_verify_model_token( $model_id, $token ) ) {
		wp_send_json_error( 'Недействительный токен.', 403 );
	}
	if ( ! $queue_id || ! in_array( $status, [ 'sent', 'error' ], true ) ) {
		wp_send_json_error( 'Некорректный результат.', 400 );
	}

	global $wpdb;
	$now  = current_time( 'mysql', true );
	$data = [
		'status'        => $status,
		'dating_status' => $http,
		'error_text'    => $error,
		'updated_at'    => $now,
	];
	$formats = [ '%s', '%d', '%s', '%s' ];

	if ( $status === 'sent' ) {
		$data['sent_at'] = $now;
		$formats[]       = '%s';
	}

	$wpdb->update(
		dco_table_name(),
		$data,
		[ 'id' => $queue_id, 'model_id' => $model_id ],
		$formats,
		[ '%d', '%d' ]
	);

	wp_send_json_success( [ 'status' => $status ] );
}

add_action( 'wp_ajax_dc_outbox_status', 'dco_ajax_status' );
function dco_ajax_status() {
	$model_id = absint( $_POST['model_id'] ?? 0 );
	$token    = sanitize_text_field( wp_unslash( $_POST['token'] ?? '' ) );
	$queue_id = absint( $_POST['queue_id'] ?? 0 );

	if ( ! is_user_logged_in() || ! dco_verify_model_token( $model_id, $token ) ) {
		wp_send_json_error( 'Нет доступа.', 403 );
	}

	global $wpdb;
	$row = $wpdb->get_row(
		$wpdb->prepare(
			'SELECT status, dating_status, error_text, updated_at, sent_at FROM ' . dco_table_name() . ' WHERE id = %d AND model_id = %d',
			$queue_id,
			$model_id
		),
		ARRAY_A
	);

	if ( ! $row ) {
		wp_send_json_error( 'Сообщение в очереди не найдено.', 404 );
	}

	wp_send_json_success( $row );
}

function dco_render_frontend_bridge() {
	if ( is_admin() || ! is_user_logged_in() ) {
		return;
	}

	$model_id = get_queried_object_id();
	if ( ! $model_id || ! dco_is_dating_model( $model_id ) ) {
		return;
	}

	$token = function_exists( 'dc_get_model_import_token' )
		? dc_get_model_import_token( $model_id )
		: (string) get_post_meta( $model_id, '_dc_import_token', true );

	$cfg = [
		'ajaxUrl'    => admin_url( 'admin-ajax.php' ),
		'modelId'    => $model_id,
		'token'      => $token,
		'operatorId' => dco_get_operator_id( $model_id ),
	];
	?>
	<script id="dc-outbound-bridge">
	(function () {
		'use strict';

		var cfg = <?php echo wp_json_encode( $cfg ); ?>;
		var activeContactId = '';
		var activeContactElement = null;
		var busy = false;

		function digits(value) {
			var match = String(value || '').match(/\d{9,15}/);
			return match ? match[0] : '';
		}

		function contactFromElement(element) {
			var node = element;
			for (var depth = 0; node && depth < 10; depth++, node = node.parentElement) {
				var attrs = ['data-user_id', 'data-user-id', 'data-contact_id', 'data-contact-id', 'data-sender', 'data-recipient'];
				for (var i = 0; i < attrs.length; i++) {
					var id = digits(node.getAttribute && node.getAttribute(attrs[i]));
					if (id && id !== String(cfg.operatorId)) return id;
				}
			}
			return '';
		}

		function findComposer(button) {
			var scope = button.closest('.modal, .modal-content, [role="dialog"], .chat-modal, .chat-content') || document;
			var fields = scope.querySelectorAll('textarea, input[type="text"]');
			for (var i = fields.length - 1; i >= 0; i--) {
				var field = fields[i];
				var rect = field.getBoundingClientRect();
				if (!field.disabled && rect.width > 20 && rect.height > 15) return field;
			}
			return null;
		}

		function setButtonState(button, text, disabled) {
			button.disabled = !!disabled;
			button.dataset.dcOriginalText = button.dataset.dcOriginalText || (button.value || button.textContent || 'Отправить').trim();
			if (button.tagName === 'INPUT') button.value = text;
			else button.textContent = text;
		}

		function restoreButton(button) {
			setButtonState(button, button.dataset.dcOriginalText || 'Отправить', false);
		}

		function formPost(fields) {
			var fd = new FormData();
			Object.keys(fields).forEach(function (key) { fd.append(key, fields[key]); });
			return fetch(cfg.ajaxUrl, {
				method: 'POST',
				body: fd,
				credentials: 'same-origin'
			}).then(function (response) {
				return response.json().catch(function () { throw new Error('CRM вернула неверный ответ.'); });
			});
		}


		function scrollActiveChatToBottom() {
			[100, 300, 700, 1200, 2000].forEach(function (delay) {
				setTimeout(function () {
					var scopes = document.querySelectorAll(
						'.modal, .modal-content, [role="dialog"], ' +
						'.chat-modal, .chat-content'
					);

					var scope = null;

					for (var i = 0; i < scopes.length; i++) {
						var rect = scopes[i].getBoundingClientRect();

						if (
							rect.width > 200 &&
							rect.height > 150 &&
							rect.bottom > 0 &&
							rect.right > 0
						) {
							scope = scopes[i];
						}
					}

					if (!scope) return;

					var nodes = [scope].concat(
						Array.prototype.slice.call(
							scope.querySelectorAll('*')
						)
					);

					var best = null;
					var bestOverflow = 0;

					for (var j = 0; j < nodes.length; j++) {
						var node = nodes[j];
						var overflow =
							node.scrollHeight - node.clientHeight;

						if (
							node.clientHeight > 80 &&
							overflow > bestOverflow
						) {
							best = node;
							bestOverflow = overflow;
						}
					}

					if (best && bestOverflow > 20) {
						best.scrollTop = best.scrollHeight;

						if (best.scrollTo) {
							best.scrollTo({
								top: best.scrollHeight,
								behavior: 'auto'
							});
						}
					}
				}, delay);
			});
		}

		function waitForResult(queueId, button, input, startedAt) {
			formPost({
				action: 'dc_outbox_status',
				model_id: cfg.modelId,
				token: cfg.token,
				queue_id: queueId
			}).then(function (result) {
				if (!result.success) throw new Error(result.data || 'Не удалось проверить отправку.');
				var status = result.data.status;
				if (status === 'sent') {
					input.value = '';
					input.dispatchEvent(new Event('input', { bubbles: true }));
					setButtonState(button, 'Отправлено', true);
					busy = false;
					setTimeout(function () {
						restoreButton(button);

						if (
							activeContactElement &&
							document.contains(activeContactElement)
						) {
							activeContactElement.click();
						}

						scrollActiveChatToBottom();
					}, 500);
					return;
				}
				if (status === 'error') {
					throw new Error(result.data.error_text || ('Dating.com HTTP ' + result.data.dating_status));
				}
				if (Date.now() - startedAt > 120000) {
					throw new Error('Сообщение осталось в очереди больше двух минут. Проверьте коннектор.');
				}
				setButtonState(button, status === 'processing' ? 'Отправляется…' : 'В очереди…', true);
				setTimeout(function () { waitForResult(queueId, button, input, startedAt); }, 1500);
			}).catch(function (error) {
				busy = false;
				restoreButton(button);
				alert('Ошибка отправки Dating.com: ' + error.message);
			});
		}

		document.addEventListener('click', function (event) {
			var contactNode = event.target.closest && event.target.closest('[data-user_id], [data-user-id], [data-contact_id], [data-contact-id], [data-sender], [data-recipient], .dc-contact-row');
			if (!contactNode) return;
			var id = contactFromElement(contactNode);
			if (id) {
				activeContactId = id;
				activeContactElement = contactNode;
			}
		}, true);

		document.addEventListener('click', function (event) {
			var button = event.target.closest && event.target.closest('button, input[type="button"], input[type="submit"], a');
			if (!button) return;
			var label = (button.value || button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
			if (label !== 'отправить') return;

			var input = findComposer(button);
			if (!input) return;

			var localContactId = contactFromElement(button) || contactFromElement(input) || activeContactId;
			if (!localContactId) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				alert('Не удалось определить контакт. Закройте чат, откройте его повторно и отправьте сообщение ещё раз.');
				return;
			}

			var text = String(input.value || '').trim();
			if (!text || busy) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			busy = true;
			setButtonState(button, 'В очереди…', true);

			formPost({
				action: 'dc_outbox_enqueue',
				model_id: cfg.modelId,
				token: cfg.token,
				contact_id: localContactId,
				text: text
			}).then(function (result) {
				if (!result.success) throw new Error(result.data || 'CRM не приняла сообщение.');
				waitForResult(result.data.queue_id, button, input, Date.now());
			}).catch(function (error) {
				busy = false;
				restoreButton(button);
				alert('Ошибка очереди Dating.com: ' + error.message);
			});
		}, true);
	})();
	</script>
	<?php
}
add_action( 'wp_footer', 'dco_render_frontend_bridge', 99999 );