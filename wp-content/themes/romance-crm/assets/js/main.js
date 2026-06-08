$(function () {
  function checkChatMessages() {
    var user_id = $(document)
      .find("#chatModalContent .chat-messages")
      .data("user_id");
    var chat_id = $(document)
      .find("#chatModalContent .chat-messages")
      .data("chat_id");
    $.ajax({
      url: ajaxurl,
      type: "POST",
      dataType: "json",
      data: {
        action: "check_message",
        user_id: user_id,
        chat_id: chat_id,
        id: modelId,
      },
      success: function (response) {
        if (response.success) {
          $("#chatModalContent .messages").html(response.data);
        } else {
          $("#chatModalContent").html(
            '<div class="text-danger">Ошибка: ' + response.data + "</div>"
          );
        }
      },
      error: function (xhr, status, error) {
        $("#chatModalContent").html(
          '<div class="text-danger">AJAX ошибка: ' + error + "</div>"
        );
      },
    });
  }

  // ── Dating.com chat polling (5 s, smart scroll, sound on new inbound) ────
  var dcChatInterval = null;

  function checkDCMessages() {
    var $chatMsgs = $("#chatModalContent .chat-messages");
    if (!$chatMsgs.length || $chatMsgs.data("source") !== "dating_com") return;

    var user_id = $chatMsgs.data("user_id");

    // Remember scroll position before replace
    var $scrollEl = $("#chatModal .modal-body");
    var wasNearBottom = false;
    if ($scrollEl.length) {
      var sh = $scrollEl[0].scrollHeight;
      var st = $scrollEl.scrollTop();
      var ch = $scrollEl[0].clientHeight;
      wasNearBottom = sh - st - ch < 80;
    }

    // Count inbound messages before update
    var prevInbound = $("#chatModalContent .chat-message.text-start").length;

    $.ajax({
      url: ajaxurl,
      type: "POST",
      dataType: "json",
      data: { action: "check_message", user_id: user_id, chat_id: 0, id: modelId },
      success: function (response) {
        if (!response.success) return;

        var $parsed = $(response.data);
        var newInbound = $parsed.find(".chat-message.text-start").length;
        if ($parsed.is(".chat-message.text-start")) newInbound++;

        $("#chatModalContent .messages").html(response.data);

        if (newInbound > prevInbound && window.crmNotifySound) {
          window.crmNotifySound.play().catch(function () {});
        }

        if (wasNearBottom && $scrollEl.length) {
          $scrollEl.scrollTop($scrollEl[0].scrollHeight);
        }
      },
    });
  }

  function startDCChatPolling() {
    stopDCChatPolling();
    dcChatInterval = setInterval(checkDCMessages, 5000);
  }

  function stopDCChatPolling() {
    if (dcChatInterval) {
      clearInterval(dcChatInterval);
      dcChatInterval = null;
    }
  }

  window.checkOnlineModel = function (modelId) {
    $.ajax({
      url: ajaxurl,
      type: "POST",
      dataType: "json",
      data: {
        action: "chek_online_model",
        id: modelId,
      },
      success: function (response) {
        if (response.success) {
          console.log("Заблоковано успішно");
        } else {
          alert("Ошибка: " + response.data);
        }
      },
      error: function (xhr, status, error) {
        alert("AJAX ошибка: " + error);
      },
    });
  };
  //===== Preloader

  $(window).on("load", function () {
    setTimeout(function () {
      //$(".preloader").css("opacity", "0").css("display", "none");
      // Или с анимацией:
      $(".preloader").fadeOut(300);
    }, 500);
  });

  $("#load-more").on("click", function () {
    var $button = $(this);
    var offset = parseInt($button.data("offset"));
    var total = parseInt($button.data("total"));
    var search = $button.data("search");
    var source = $button.data("source") || "all";

    $button.prop("disabled", true).text("Загрузка...");

    $.ajax({
      url: ajaxurl,
      type: "POST",
      data: {
        action: "load_more_models",
        offset: offset,
        search: search,
        source: source,
      },
      success: function (response) {
        if ($.trim(response) !== "") {
          $("#model-list").append(response);
          offset += 10;
          $button.data("offset", offset);

          if (offset >= total) {
            $button.remove();
          } else {
            $button.prop("disabled", false).text("Показать ещё");
          }
        } else {
          $button.remove();
        }
      },
    });
  });

  $(".login-form form").on("submit", function (e) {
    e.preventDefault();

    let email = $(this).find('input[name="log"]').val().trim();
    let password = $(this).find('input[name="pwd"]').val().trim();

    $(".login-message").remove();

    $.ajax({
      url: ajaxurl, // WordPress глобальная переменная
      type: "POST",
      dataType: "json",
      data: {
        action: "custom_ajax_login",
        log: email,
        pwd: password,
      },
      success: function (response) {
        if (response.success) {
          location.reload(); // или перенаправление на профиль
        } else {
          $(document).find(".login-text").html(response.message);
        }
      },
      error: function () {
        $(document).find(".login-text").html("Error");
      },
    });
  });

  $(document).on("click", "#goFavorite", function (e) {
    e.preventDefault();

    var $this = $(this);
    var user_id = $this.data("user_id");
    var favorite = $this.data("favorite");

    favorite = favorite == "1" ? "0" : "1";

    // Detect DC contact rows by their wrapper class
    var $dcRow = $this.closest(".dc-contact");
    var isDC = $dcRow.length > 0;

    $.ajax({
      url: ajaxurl,
      type: "POST",
      dataType: "json",
      data: {
        action: "toggle_favorite",
        user_id: user_id,
        favorite: favorite,
        id: modelId,
      },
      success: function (response) {
        if (response.success) {
          var icon = favorite == "1" ? "★" : "☆";
          $this.find(".favorite-indicator").html(icon);
          $this.data("favorite", favorite);

          if (isDC) {
            // Sync HTML attr for CSS [data-favorite="1"] selector
            $this.attr("data-favorite", favorite);
            if (favorite == "1") {
              $dcRow.addClass("is-favorite");
            } else {
              $dcRow.removeClass("is-favorite");
            }

            // Instant DOM re-sort: detach the row and reinsert it at the
            // correct position immediately (no AJAX latency).
            // The 15 s fetchContactList poll can arrive after our server
            // refresh and silently overwrite the sorted list with stale
            // data — this client-side move makes the visual update instant
            // regardless of race timing.
            var $list = $(".contact-list .response");
            $dcRow.detach();
            var $lastFav = $list.find(".dc-contact.is-favorite").last();
            if ($lastFav.length) {
              $dcRow.insertAfter($lastFav);
            } else {
              $list.prepend($dcRow);
            }

            // Server refresh for ordering consistency on the next render.
            $.ajax({
              url: ajaxurl,
              type: "POST",
              dataType: "json",
              data: { action: "get_contact_list", id: modelId },
              success: function (r) {
                if (r.success) {
                  $(".contact-list .response").html(r.data);
                }
              },
            });
          }
        } else {
          alert("Ошибка: " + response.data);
        }
      },
      error: function (xhr, status, error) {
        alert("AJAX ошибка: " + error);
      },
    });
  });

  $(document).on("click", "#goRemove", function (e) {
    e.preventDefault();

    var $this = $(this);
    var user_id = $this.data("user_id"); // в твоём HTML data-id — здесь правильный атрибут
    if (confirm("Вы уверены, что хотите удалить этот контакт?")) {
      $.ajax({
        url: ajaxurl,
        type: "POST",
        dataType: "json",
        data: {
          action: "delete_contact",
          user_id: user_id,
          id: modelId,
        },
        success: function (response) {
          if (response.success) {
            $this.closest(".contact-card").remove();
          } else {
            alert("Ошибка: " + response.data);
          }
        },
        error: function (xhr, status, error) {
          alert("AJAX ошибка: " + error);
        },
      });
    }
  });

  $(document).on("click", "#openChat", function (e) {
    e.preventDefault();
    var $this = $(this);
    var user_id = $this.data("user_id");
    var chat_id = $this.data("chat_id");

    /*
    if (chat_id == "0") {
      alert("Сообщений нету!");
      return;
    } */

    // Показываем модалку с загрузкой
    $("#chatModalContent").html("Загрузка...");
    $("#chatModal").modal("show");

    $.ajax({
      url: ajaxurl,
      type: "POST",
      dataType: "json",
      data: {
        action: "open_chat",
        user_id: user_id,
        chat_id: chat_id,
        id: modelId,
      },
      success: function (response) {
        if (response.success) {
          $("#chatModalContent").html(response.data);
          // Start 5 s DC polling if this is a Dating.com chat
          if ($("#chatModalContent .chat-messages[data-source='dating_com']").length) {
            startDCChatPolling();
          }
        } else {
          $("#chatModalContent").html(
            '<div class="text-danger">Ошибка: ' + response.data + "</div>"
          );
        }
      },
      error: function (xhr, status, error) {
        $("#chatModalContent").html(
          '<div class="text-danger">AJAX ошибка: ' + error + "</div>"
        );
      },
    });
  });

  $(document).on("click", "#goSpam", function (e) {
    e.preventDefault();
    $("#spamModal").modal("show");
  });

  let currentPage = 1;
  let totalPages = 1;
  let messageToSend = "";
  let isPaused = false;
  let isStopped = false;

  function sendMessagesSequentially(users, index = 0) {
    if (isStopped) {
      $(".progress-status").append(
        "<div class='text-danger'>Рассылка остановлена</div>"
      );
      scrollProgress();
      enableControls();
      return;
    }

    if (isPaused) {
      $(".progress-status").append(
        "<div class='text-warning'>Рассылка приостановлена</div>"
      );
      scrollProgress();
      // Проверяем каждые 1 секунду, снята ли пауза
      const pauseCheck = setInterval(() => {
        if (!isPaused) {
          $(".progress-status").append(
            "<div class='text-info'>Возобновляем рассылку...</div>"
          );
          scrollProgress();
          clearInterval(pauseCheck);
          sendMessagesSequentially(users, index);
        }
        if (isStopped) {
          clearInterval(pauseCheck);
          $(".progress-status").append(
            "<div class='text-danger'>Рассылка остановлена</div>"
          );
          scrollProgress();
          enableControls();
        }
      }, 1000);
      return;
    }

    if (index >= users.length) {
      if (currentPage < totalPages) {
        currentPage++;
        loadPageAndSend(currentPage);
      } else {
        $(".progress-status").append(
          "<div class='text-success'>Все сообщения отправлены</div>"
        );
        scrollProgress();
        enableControls();
      }
      return;
    }

    const user = users[index];
    $.ajax({
      url: ajaxurl,
      method: "POST",
      dataType: "json",
      data: {
        action: "send_message_to_user",
        id: modelId,
        user_id: user.id,
        message: messageToSend,
      },
      success: function (response) {
        if (response.success) {
          $(".progress-status").append(
            "<div class='text-success'>" +
              user.name +
              ": " +
              response.data +
              "</div>"
          );
        } else {
          $(".progress-status").append(
            "<div class='text-danger'>" +
              user.name +
              ": " +
              response.data +
              "</div>"
          );
        }

        scrollProgress();

        const delay = getRandomDelay(5000, 8000);
        setTimeout(() => {
          sendMessagesSequentially(users, index + 1);
        }, delay);
      },
      error: function () {
        $(".progress-status").append(
          "<div class='text-danger'>" + user.name + ": Ошибка запроса</div>"
        );
        scrollProgress();

        const delay = getRandomDelay(5000, 8000);
        setTimeout(() => {
          sendMessagesSequentially(users, index + 1);
        }, delay);
      },
    });
  }

  function loadPageAndSend(page) {
    if (isStopped) {
      $(".progress-status").append(
        "<div class='text-danger'>Рассылка остановлена</div>"
      );
      scrollProgress();
      enableControls();
      return;
    }

    $(".progress-status").append(
      "<div class='text-warning'>Загрузка страницы " + page + "...</div>"
    );
    scrollProgress();

    $.ajax({
      url: ajaxurl,
      method: "POST",
      dataType: "json",
      data: {
        action: "get_online_users",
        id: modelId,
        page: page,
      },
      success: function (response) {
        if (response.success) {
          totalPages = response.data.pages;

          const rawUsers = response.data.users;

          if (Array.isArray(rawUsers)) {
            const users = rawUsers.map((u) => ({
              id: u.id,
              name: u.name,
            }));

            $(".progress-status").append(
              "<div>Найдено " +
                users.length +
                " пользователей на странице " +
                page +
                "</div>"
            );
            scrollProgress();

            if (users.length > 0) {
              sendMessagesSequentially(users);
            } else {
              if (currentPage < totalPages) {
                currentPage++;
                loadPageAndSend(currentPage);
              } else {
                $(".progress-status").append(
                  "<div class='text-success'>Все сообщения отправлены</div>"
                );
                scrollProgress();
                enableControls();
              }
            }
          } else {
            console.log(
              "Ошибка: response.data.users не массив",
              rawUsers,
              response
            );
            $(".progress-status").append(
              "<div class='text-danger'>Ошибка: полученные пользователи не являются массивом</div>"
            );
            scrollProgress();
            enableControls();
          }
        } else {
          $(".progress-status").append(
            "<div>Ошибка загрузки пользователей: " + response.data + "</div>"
          );
          scrollProgress();
          enableControls();
        }
      },
      error: function () {
        $(".progress-status").append(
          "<div>Ошибка AJAX запроса на загрузку пользователей</div>"
        );
        scrollProgress();
        enableControls();
      },
    });
  }

  function scrollProgress() {
    const container = $(".progress-status");
    container.scrollTop(container.prop("scrollHeight"));
  }

  function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // Leave-page guard — active ONLY while broadcast is running
  function spamBeforeUnload(e) {
    e.preventDefault();
    e.returnValue = "Рассылка активна. Покинуть страницу?";
    return "Рассылка активна. Покинуть страницу?";
  }
  function setSpamActive(active) {
    if (active) {
      window.addEventListener("beforeunload", spamBeforeUnload);
    } else {
      window.removeEventListener("beforeunload", spamBeforeUnload);
    }
  }

  function enableControls() {
    setSpamActive(false);
    $("#spamModal .writemessage button.send-btn").removeAttr("disabled");
    $("#spamModal .writemessage textarea").removeAttr("disabled");
    $("#pauseBtn").attr("disabled", "disabled");
    $("#stopBtn").attr("disabled", "disabled");
  }

  function disableControls() {
    $("#spamModal .writemessage button.send-btn").attr("disabled", "disabled");
    $("#spamModal .writemessage textarea").attr("disabled", "disabled");
    $("#pauseBtn").removeAttr("disabled");
    $("#stopBtn").removeAttr("disabled");
  }

  // Старт рассылки
  $(document).on(
    "click",
    "#spamModal .writemessage button.send-btn",
    function (e) {
      e.preventDefault();
      messageToSend = $("#spamModal .writemessage textarea").val().trim();

      if (messageToSend === "") {
        alert("Напишите сообщение!");
        return;
      }

      isPaused = false;
      isStopped = false;

      disableControls();
      setSpamActive(true);
      currentPage = 1;
      $(".progress-status").html(""); // очистить статус
      loadPageAndSend(currentPage);

      var stype = "start";
      logSpam(stype);
    }
  );

  // Пауза
  $(document).on("click", "#pauseBtn", function (e) {
    e.preventDefault();
    if (!isPaused) {
      isPaused = true;
      $(this).text("Продолжить");
      $(".progress-status").append(
        "<div class='text-warning'>Пауза нажата</div>"
      );
    } else {
      isPaused = false;
      $(this).text("Пауза");
      $(".progress-status").append(
        "<div class='text-info'>Рассылка продолжена</div>"
      );
    }
  });

  // Остановка
  $(document).on("click", "#stopBtn", function (e) {
    e.preventDefault();
    if (!isStopped) {
      isStopped = true;
      isPaused = false; // чтобы не висело в паузе
      $(".progress-status").append(
        "<div class='text-danger'>Рассылка остановлена пользователем</div>"
      );
      enableControls();
      var stype = "stop";
      logSpam(stype);
    }
  });

  $(document).on("click", "#chatModal .writemessage button", function (e) {
    e.preventDefault();

    var $this = $(this);
    var user_id = $(document)
      .find("#chatModalContent .chat-messages")
      .data("user_id"); // в твоём HTML data-id — здесь правильный атрибут
    var message = $(document).find("#chatModal .writemessage textarea").val();

    if (message == "") {
      alert("Напишите сообщение!");
      return;
    }

    $(document)
      .find("#chatModal .writemessage textarea")
      .attr("disabled", "disabled");
    $this.attr("disabled", "disabled");

    $.ajax({
      url: ajaxurl,
      type: "POST",
      dataType: "json",
      data: {
        action: "send_message",
        user_id: user_id,
        message: message,
        id: modelId,
      },
      success: function (response) {
        if (response.success) {
          const chatId = response.data.chat_id;

          // Очистка и разблокировка формы

          $(document)
            .find("#chatModalContent .chat-messages")
            .attr("data-chat_id", chatId);
          checkChatMessages();
          $(document)
            .find("#chatModal .writemessage textarea")
            .val("")
            .removeAttr("disabled");
          $this.removeAttr("disabled");
        } else {
          alert("Ошибка: " + response.data);
          $(document)
            .find("#chatModal .writemessage textarea")
            .removeAttr("disabled");
          $this.removeAttr("disabled");
        }
      },
      error: function (xhr, status, error) {
        alert("AJAX ошибка: " + error);
      },
    });
  });
  let chatInterval;

  $("#chatModal").on("shown.bs.modal", function () {
    setTimeout(function () {
      // Запускаем интервал
      chatInterval = setInterval(function () {
        const chatId = $("#chatModalContent .chat-messages").data("chat_id");
        if (chatId && chatId != 0) {
          checkChatMessages();
        }
      }, 15000); // каждые 15 секунд
    }, 2000); // через 2 секунды после открытия
  });

  // Очистить интервал при закрытии модалки
  $("#chatModal").on("hidden.bs.modal", function () {
    clearInterval(chatInterval);
    stopDCChatPolling();
  });

  function logSpam(stype) {
    $.ajax({
      url: ajaxurl,
      type: "POST",
      dataType: "json",
      data: {
        action: "action_spam",
        type: stype,
        id: modelId,
      },
      success: function (response) {},
      error: function (xhr, status, error) {},
    });
  }
});
